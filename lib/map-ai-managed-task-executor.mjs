import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  parseTiledDocument,
  serializeTiledDocument,
} from "../public/map-editor/tiled-document.js";
import {
  parseTiledAiPatch,
  prepareTiledAiPatchFills,
  applyTiledAiPatch,
  previewTiledAiPatch,
} from "../public/map-editor/tiled-ai-patch.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import { assessMapAiTask } from "./map-ai-risk.mjs";
import { inspectMapFile } from "./map-file-sessions.mjs";
import { assertProtectedTargetsUnchanged, findProtectedOperationViolations, normalizeProtectedTargets } from "./map-ai-protected-targets.mjs";
import { assertMapPatchRuntimeCompatible, inspectMapRuntimeCapabilities } from "./map-runtime-capabilities.mjs";
import { summarizeTiledPatchImpact } from "./map-ai-diff.mjs";
import { collaborationPolicyProtectedTargets, findCollaborationOperationViolations } from "./map-collaboration-policy-store.mjs";

const SHA256 = /^[a-f0-9]{64}$/iu;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RESOURCE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Executes one persisted headless map-AI contract.  The executor is deliberately
 * boring: it reads one .tmj, validates one structured patch, and delegates the
 * final bytes to MapSaveSessionStore.  It never accepts a path from the plan,
 * never runs a model, and never resumes work implicitly after a restart.
 */
export class MapAiManagedTaskExecutor {
  constructor({
    taskStore,
    authorizationStore,
    saveSessions,
    now = Date.now,
    readFile = fs.readFile,
    authorize = null,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
    concurrency = 1,
    patchWorker = null,
    projectResourceWriter = null,
    resourceCandidateStore = null,
    revisionStore = null,
  } = {}) {
    if (!taskStore || !authorizationStore || !saveSessions) throw new TypeError("taskStore, authorizationStore and saveSessions are required");
    this.taskStore = taskStore;
    this.authorizationStore = authorizationStore;
    this.saveSessions = saveSessions;
    this.now = typeof now === "function" ? now : Date.now;
    this.readFile = readFile;
    this.authorize = typeof authorize === "function" ? authorize : async () => {};
    this.chunkBytes = positiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES);
    this.maxReadBytes = positiveInteger(maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.concurrency = positiveInteger(concurrency, 1);
    this.patchWorker = typeof patchWorker === "function" ? patchWorker : null;
    this.projectResourceWriter = projectResourceWriter;
    this.resourceCandidateStore = resourceCandidateStore;
    this.revisionStore = revisionStore;
    this.active = 0;
    this.pending = [];
    this.running = new Map();
  }

  setProjectResourceWriter(writer) {
    this.projectResourceWriter = writer || null;
    return this.projectResourceWriter;
  }

  setRevisionStore(store) {
    this.revisionStore = store || null;
    return this.revisionStore;
  }

  setResourceCandidateStore(store) {
    this.resourceCandidateStore = store || null;
    return this.resourceCandidateStore;
  }

  async execute(input = {}) {
    const taskId = String(input.taskId || "");
    const identity = normalizeIdentity(input.identity);
    if (!taskId) throw executorError(400, "MAP_AI_TASK_ID_INVALID", "taskId 无效");
    const running = this.running.get(taskId);
    if (running) {
      // A task id is opaque, but it is still a value supplied by the caller.
      // Never let a request from another user/session join an in-flight
      // promise and observe its bounded task receipt.  The task store will
      // also enforce the identity when no execution is currently running;
      // this guard closes the otherwise special in-flight path.
      if (!sameIdentity(running.identity, identity)) {
        throw executorError(404, "MAP_AI_TASK_NOT_FOUND", "地图 AI 托管任务不存在或已过期");
      }
      return running.promise;
    }
    const operation = new Promise((resolve, reject) => {
      this.pending.push({ taskId, identity, resolve, reject });
    });
    this.running.set(taskId, { identity: { ...identity }, promise: operation });
    this.drain();
    let value;
    try {
      value = await operation;
      return value;
    } finally {
      if (this.running.get(taskId)?.promise === operation) this.running.delete(taskId);
      // An operation-level commit leaves the durable task queued. Generate the
      // next approval card in a later turn; it never performs a write without
      // a new explicit approval.
      if (value?.status === "queued"
        && Number.isSafeInteger(value.nextOperationIndex)
        && Number.isSafeInteger(value.planSummary?.operationCount)
        && value.nextOperationIndex < value.planSummary.operationCount) {
        setImmediate(() => { void this.execute({ taskId, identity }).catch(() => {}); });
      }
    }
  }

  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const entry = this.pending.shift();
      this.active += 1;
      void this.executeUnlocked(entry.taskId, entry.identity)
        .then(entry.resolve, entry.reject)
        .finally(() => { this.active -= 1; this.drain(); });
    }
  }

  async executeUnlocked(taskId, identity) {
    const contract = this.taskStore.executionContract({ taskId, identity });
    if (!["queued", "running"].includes(contract.status)) {
      return this.taskStore.snapshot({ taskId, identity });
    }
    if (contract.expiresAt <= this.now()) {
      return this.taskStore.fail({ identity, taskId, code: "MAP_AI_TASK_EXPIRED", message: "托管授权已过期，任务未执行" });
    }
    if (contract.controlMode === "human" || contract.pauseRequested) {
      return this.taskStore.snapshot({ taskId, identity });
    }
    if (contract.plan === null) {
      return this.taskStore.fail({ identity, taskId, code: "MAP_AI_TASK_PLAN_MISSING", message: "托管任务没有可执行的结构化计划" });
    }

    let authority;
    try {
      authority = this.authorizationStore.taskContract({
        authorizationId: contract.authority.managedAuthorizationId,
        identity,
      });
      assertAuthorityMatches(contract.authority, authority);
      await this.authorize({ authority, task: contract });
    } catch (error) {
      return this.settleExecutionFailure({ identity, taskId, error, fallbackCode: "MAP_AI_AUTHORIZATION_INVALID", fallbackMessage: "托管授权校验失败" });
    }
    // Project-wide grants deliberately keep no frozen map list. A task still
    // carries the exact resource versions it intends to touch; merge that
    // immutable task snapshot into the execution view while retaining the
    // project-wide grant as the live authority.
    if (authority.scope.projectWide === true) {
      const taskAuthority = contract.authority || {};
      authority = {
        ...authority,
        scope: {
          ...authority.scope,
          scopeKind: "project",
          projectWide: true,
          threadId: null,
          mapPath: taskAuthority.mapPath,
          mapPaths: taskAuthority.mapPaths || [taskAuthority.mapPath],
          mapVersions: taskAuthority.mapVersions || { [taskAuthority.mapPath]: taskAuthority.baseVersion },
          targetFiles: taskAuthority.targetFiles || taskAuthority.mapPaths || [taskAuthority.mapPath],
          targetFileVersions: taskAuthority.targetFileVersions || taskAuthority.mapVersions || { [taskAuthority.mapPath]: taskAuthority.baseVersion },
        },
      };
    }
    const effectiveProtectedTargets = protectedTargetsForAuthority(authority);
    if (isMultiMapPlan(contract.plan)) {
      return this.executeMultiMapPlan({ contract, identity, authority, taskId, effectiveProtectedTargets });
    }
    if (isResourcePatchPlan(contract.plan)) {
      return this.executeResourcePatchPlan({ contract, identity, authority, taskId });
    }

    let targetPath = null;
    const batchId = crypto.randomBytes(18).toString("base64url");
    let inspected;
    let patch;
    let preview;
    let risk;
    let workerLease = null;
    let save = null;
    let saveIdentity = null;
    let protectedBaselineDocument = null;
    let impactDocument = null;
    let impact = null;
    let revisionStage = null;
    try {
      targetPath = await resolveManagedMapTarget(
        authority.scope.projectPath,
        authority.scope.mapPaths[0],
      );
      const maxReadBytes = boundedReadLimit(contract.settingsSnapshot?.maxMapReadBytes, this.maxReadBytes);
      inspected = await inspectMapFile(targetPath, { maxBytes: maxReadBytes });
      if (inspected.version !== contract.currentVersion
        || (contract.nextOperationIndex === 0 && inspected.version !== authority.scope.mapVersions[authority.scope.mapPaths[0]])) {
        return this.taskStore.conflict({ identity, taskId });
      }
      let restoreProtectedBaseline = null;
      if (contract.plan?.format === "wfl-map-revision-restore" && effectiveProtectedTargets.length) {
        const source = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        restoreProtectedBaseline = parseTiledDocument(source, {
          expectedKind: "map",
          sourcePath: authority.scope.mapPaths[0],
        }).document;
      }
      if (contract.plan?.format === "wfl-map-revision-restore" && this.revisionStore) {
        return await this.executeRevisionRestore({
          contract, identity, authority, targetPath, inspected, taskId, batchId,
          protectedBaselineDocument: restoreProtectedBaseline,
          effectiveProtectedTargets,
        });
      }
      const versionedPlan = planWithBaseVersion(contract.plan, inspected.version);
      // Collaboration policies may carry human/locked targets even when a
      // legacy task contract was created before the authorization store
      // expanded them into protectedTargets.  Load the baseline whenever
      // either representation can require a deny check; otherwise a direct
      // managed executor call could validate against an empty document and
      // miss a policy violation.
      if (effectiveProtectedTargets.length || authority.collaborationPolicy?.targets?.length) {
        const protectedSource = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        protectedBaselineDocument = parseTiledDocument(protectedSource, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] }).document;
      }
      if (this.patchWorker) {
        const rawPlan = versionedPlan;
        patch = patchRiskShape(rawPlan);
        const runtimeCapabilities = await inspectMapRuntimeCapabilities({
          projectPath: authority.scope.projectPath,
          mapPath: authority.scope.mapPaths[0],
        });
        // Fail in the host before spawning a Worker when the current runtime
        // contract already proves the operation cannot load in-game.
        const runtimeSource = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        const runtimeParsed = parseTiledDocument(runtimeSource, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] });
        impactDocument = runtimeParsed.document;
        const runtimePatch = parsePlanPatch(rawPlan, { mapPath: authority.scope.mapPaths[0], mapVersion: inspected.version });
        assertMapPatchRuntimeCompatible(runtimeParsed.document, runtimePatch, runtimeCapabilities);
        const workerResult = await this.patchWorker({
          id: taskId,
          mode: "preview",
          projectPath: authority.scope.projectPath,
          targetPath,
          mapPath: authority.scope.mapPaths[0],
          expectedVersion: inspected.version,
          maxReadBytes,
          plan: rawPlan,
          memoryMb: managedWorkerSetting(contract.settingsSnapshot, "memoryMb"),
          timeoutMs: managedWorkerSetting(contract.settingsSnapshot, "timeoutMs"),
          protectedTargets: effectiveProtectedTargets,
          runtimeCapabilities,
        });
        preview = workerResult.preview;
        impact = workerResult.impact || null;
      } else {
        const source = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] });
        impactDocument = parsed.document;
        patch = parsePlanPatch(versionedPlan, {
          mapPath: authority.scope.mapPaths[0],
          mapVersion: inspected.version,
        });
        preview = previewPatch(parsed.document, patch);
        const runtimeCapabilities = await inspectMapRuntimeCapabilities({
          projectPath: authority.scope.projectPath,
          mapPath: authority.scope.mapPaths[0],
        });
        assertMapPatchRuntimeCompatible(parsed.document, patch, runtimeCapabilities);
      }
      impact = summarizeTiledPatchImpact(impactDocument, patch, { maxHeat: 512 });
      const protectedViolations = findProtectedOperationViolations(
        protectedBaselineDocument,
        patch,
        effectiveProtectedTargets,
        authority.scope.mapPaths[0],
      );
      if (protectedViolations.length) {
        return this.taskStore.fail({ identity, taskId, code: "MAP_AI_PROTECTED_OPERATION", message: protectedViolations[0].message });
      }
      if (authority.collaborationPolicy) {
        const collaborationViolations = findCollaborationOperationViolations(
          protectedBaselineDocument,
          patch,
          authority.collaborationPolicy,
          authority.scope.mapPaths[0],
        );
        if (collaborationViolations.length) {
          return this.taskStore.fail({ identity, taskId, code: collaborationViolations[0].code || "MAP_COLLABORATION_HUMAN_OWNED", message: collaborationViolations[0].message });
        }
      }
      const fullRisk = assessMapAiTask({
        approvalPolicy: contract.approvalSnapshot.policy,
        operations: patch.operations,
        targetMapPaths: [authority.scope.mapPaths[0]],
        targetFiles: authority.scope.targetFiles,
        tileCellCount: preview.tileCellCount,
        ordinaryObjectCount: preview.ordinaryObjectCount,
        mapCount: 1,
          protectedTargets: effectiveProtectedTargets,
        gates: {
          authorization: authority.allowedOps.includes("apply_tiled_patch"),
          // Structured protected targets are enforced against the parsed
          // candidate below; this gate must not rely on string equality.
          protected: true,
          version: true,
          path: true,
          tiled: true,
          transaction: true,
        },
      });
      if (fullRisk.hardBlocks.length || fullRisk.decision.status === "blocked") {
        return this.taskStore.fail({ identity, taskId, code: "MAP_AI_TASK_HARD_BLOCK", message: `托管计划被固定安全规则阻止：${fullRisk.hardBlocks.join(", ") || "blocked"}` });
      }
      const operationApproval = fullRisk.decision.approvalUnit === "operation";
      const operationIndex = operationApproval ? contract.nextOperationIndex : 0;
      if (operationIndex >= patch.operations.length) {
        return this.taskStore.succeed({ identity, taskId, summary: patch.summary });
      }
      if (operationApproval) {
        const operationPlan = planWithBaseVersion(versionedPlan, inspected.version, [patch.operations[operationIndex]]);
        if (this.patchWorker) {
          const workerResult = await this.patchWorker({
            id: `${taskId}-operation-${operationIndex}`,
            mode: "preview",
            projectPath: authority.scope.projectPath,
            targetPath,
            mapPath: authority.scope.mapPaths[0],
            expectedVersion: inspected.version,
            maxReadBytes,
            plan: operationPlan,
            memoryMb: managedWorkerSetting(contract.settingsSnapshot, "memoryMb"),
            timeoutMs: managedWorkerSetting(contract.settingsSnapshot, "timeoutMs"),
            protectedTargets: effectiveProtectedTargets,
            runtimeCapabilities: await inspectMapRuntimeCapabilities({ projectPath: authority.scope.projectPath, mapPath: authority.scope.mapPaths[0] }),
          });
          preview = workerResult.preview;
          impact = workerResult.impact || null;
        } else {
          const source = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
          const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] });
          patch = parsePlanPatch(operationPlan, { mapPath: authority.scope.mapPaths[0], mapVersion: inspected.version });
          preview = previewPatch(parsed.document, patch);
        }
        patch = patchRiskShape(operationPlan);
        risk = assessMapAiTask({
          approvalPolicy: contract.approvalSnapshot.policy,
          operations: patch.operations,
          targetMapPaths: [authority.scope.mapPaths[0]],
          targetFiles: authority.scope.targetFiles,
          tileCellCount: preview.tileCellCount,
          ordinaryObjectCount: preview.ordinaryObjectCount,
          mapCount: 1,
          protectedTargets: effectiveProtectedTargets,
          gates: { authorization: true, protected: true, version: true, path: true, tiled: true, transaction: true },
        });
      } else {
        risk = fullRisk;
      }
      if (operationApproval && impactDocument) impact = summarizeTiledPatchImpact(impactDocument, patch, { maxHeat: 512 });
      if (risk.decision.requiresUser && !contract.approvalOverride) {
        await this.taskStore.recordCheckpoint({
          identity, taskId, batchId, phase: "awaiting_approval", baseVersion: inspected.version,
          targetVersion: inspected.version, operationCount: risk.operationCount,
          operationIndex: operationApproval ? operationIndex : null,
          nextOperationIndex: contract.nextOperationIndex,
          summary: patch.summary,
          risk: riskReceipt(risk), diff: previewSummary(preview, patch, impact), validation: validationReceipt({ stage: "candidate-preview", worker: this.patchWorker ? { status: "completed", isolation: "dedicated-map-ai-worker" } : { status: "main-process-fallback", isolation: "bounded-local-validation" } }),
        });
        return this.taskStore.snapshot({ taskId, identity });
      }
      await this.taskStore.recordCheckpoint({
        identity, taskId, batchId, phase: "started", baseVersion: inspected.version,
        targetVersion: inspected.version, operationCount: risk.operationCount,
        operationIndex: operationApproval ? operationIndex : null,
        nextOperationIndex: contract.nextOperationIndex,
        summary: patch.summary,
        risk: riskReceipt(risk), diff: previewSummary(preview, patch, impact), validation: validationReceipt({ stage: "candidate-preview", worker: this.patchWorker ? { status: "started", isolation: "dedicated-map-ai-worker" } : { status: "main-process-fallback", isolation: "bounded-local-validation" } }),
      });
      let bytes;
      let totalHash;
      let candidatePath = null;
      if (this.patchWorker) {
        workerLease = await this.patchWorker({
          id: taskId,
          mode: "apply",
          projectPath: authority.scope.projectPath,
          targetPath,
          mapPath: authority.scope.mapPaths[0],
          expectedVersion: inspected.version,
          maxReadBytes,
          plan: operationApproval
            ? planWithBaseVersion(versionedPlan, inspected.version, [planValue(versionedPlan).operations[operationIndex]])
            : versionedPlan,
          memoryMb: managedWorkerSetting(contract.settingsSnapshot, "memoryMb"),
          timeoutMs: managedWorkerSetting(contract.settingsSnapshot, "timeoutMs"),
          protectedTargets: effectiveProtectedTargets,
          runtimeCapabilities: await inspectMapRuntimeCapabilities({ projectPath: authority.scope.projectPath, mapPath: authority.scope.mapPaths[0] }),
        });
        candidatePath = workerLease.candidate?.path;
        if (!candidatePath) throw executorError(500, "MAP_AI_WORKER_CANDIDATE_MISSING", "地图 AI Worker 未返回候选地图");
        const candidateStat = await fs.stat(candidatePath);
        bytes = null;
        totalHash = workerLease.candidate.sha256;
        if (candidateStat.size !== workerLease.candidate.size) throw executorError(502, "MAP_AI_WORKER_CANDIDATE_INVALID", "地图 AI Worker 候选地图大小不一致");
      } else {
        const source = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] });
        patch = parsePlanPatch(operationApproval
          ? planWithBaseVersion(versionedPlan, inspected.version, [planValue(versionedPlan).operations[operationIndex]])
          : versionedPlan, {
          mapPath: authority.scope.mapPaths[0],
          mapVersion: inspected.version,
        });
        const prepared = prepareTiledAiPatchFills(parsed.document, patch);
        const editor = new TiledEditDocument(parsed.document);
        applyTiledAiPatch(editor, patch, { fillResults: prepared.fillResults, label: `托管 AI：${patch.summary}` });
        const candidate = editor.exportDocument();
        bytes = new TextEncoder().encode(serializeTiledDocument(candidate, {
          expectedKind: "map", sourcePath: authority.scope.mapPaths[0], space: 2,
        }));
        totalHash = sha256(bytes);
      }
      if (protectedBaselineDocument && effectiveProtectedTargets.length) {
        const candidateSource = bytes
          ? new TextDecoder().decode(bytes)
          : await readBoundedUtf8(candidatePath, maxReadBytes, this.readFile);
        const candidateDocument = parseTiledDocument(candidateSource, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] }).document;
        assertProtectedTargetsUnchanged(
          protectedBaselineDocument,
          candidateDocument,
          effectiveProtectedTargets,
          authority.scope.mapPaths[0],
        );
      }
      saveIdentity = { ...identity, editorInstanceId: `managed-${taskId.slice(0, 96)}` };
      save = await this.saveSessions.begin({
        identity: saveIdentity,
        mapContext: {
          mapSessionId: `managed-task-${taskId}`,
          projectPath: authority.scope.projectPath,
          targetPath,
          relativePath: authority.scope.mapPaths[0],
          documentKind: "map",
          version: inspected.version,
          writable: true,
        },
        expectedVersion: inspected.version,
        totalBytes: bytes ? bytes.byteLength : workerLease.candidate.size,
        totalHash,
        clientOperationId: `managed-save-${taskId}-${inspected.version}`,
        config: { chunkBytes: this.chunkBytes },
      });
      for (let index = 0; index < save.chunkCount; index += 1) {
        const start = index * save.config.chunkBytes;
        const end = Math.min(save.totalBytes, start + save.config.chunkBytes);
        const chunk = bytes
          ? bytes.subarray(start, end)
          : await readFileRange(candidatePath, start, end - start);
        await this.saveSessions.uploadChunk({
          saveId: save.id, identity: saveIdentity, documentKind: "map", index,
          source: chunk, contentLength: chunk.byteLength, chunkHash: sha256(chunk),
        });
      }
      const authorizeLive = async (context) => {
        await this.authorizeLive({ taskId, identity, authority, context, protectedBaselineDocument });
      };
      let result;
      let transaction = null;
      let revision = null;
      let revisionError = null;
      try {
        if (this.revisionStore) revisionStage = await this.revisionStore.stageCurrent({
          projectPath: authority.scope.projectPath,
          relativePath: authority.scope.mapPaths[0],
          targetPath,
          expectedVersion: inspected.version,
          reason: "managed-ai-save",
          actor: { userId: identity.userId, browserSessionId: identity.browserSessionId, taskId },
        });
      } catch (error) {
        revisionError = { code: String(error?.code || "MAP_REVISION_STAGE_FAILED"), message: "修订快照未创建，地图保存仍继续" };
      }
      if (this.projectResourceWriter) {
        // The managed writer follows the same candidate -> project transaction
        // boundary as the browser editor.  AI never writes the target through
        // MapSaveSessionStore directly, so a multi-file extension can be
        // added without creating a second atomicity model.
        const candidate = await this.saveSessions.prepareCandidate({
          saveId: save.id,
          identity: saveIdentity,
          documentKind: "map",
          authorize: authorizeLive,
        });
        transaction = await this.projectResourceWriter.saveTransaction({
          projectPath: authority.scope.projectPath,
          resourceRoots: [""],
          validateReferences: true,
          validate: async () => {
            await authorizeLive({
              projectPath: authority.scope.projectPath,
              targetPath,
              relativePath: authority.scope.mapPaths[0],
              version: inspected.version,
              writable: true,
            });
          },
          files: [{
            relativePath: authority.scope.mapPaths[0],
            candidatePath: candidate.candidatePath,
            candidateSize: candidate.size,
            candidateSha256: candidate.sha256,
            expectedVersion: candidate.expectedVersion,
          }],
        });
        result = await this.saveSessions.finalizeCandidate({
          saveId: save.id,
          identity: saveIdentity,
          documentKind: "map",
          candidate,
          published: transaction.files?.[0],
        });
      } else {
        // Unit-test and legacy embedders may not provide the project writer;
        // retain the bounded single-file path there. Production wiring always
        // supplies the writer.
        result = await this.saveSessions.commit({
          saveId: save.id, identity: saveIdentity, documentKind: "map",
          authorize: authorizeLive,
        });
      }
      if (revisionStage && this.revisionStore) {
        try {
          revision = await this.revisionStore.commitStaged(revisionStage);
        } catch (error) {
          revisionError = { code: String(error?.code || "MAP_REVISION_COMMIT_FAILED"), message: "地图已保存，但修订快照未持久化" };
          await this.revisionStore.disposeStaged(revisionStage).catch(() => {});
        }
        revisionStage = null;
      }
      // A commit must not leave a transient save session around if checkpoint
      // persistence fails; the target file is already atomic and can be
      // inspected on the next explicit recovery attempt.
      await this.taskStore.recordCheckpoint({
        identity, taskId, batchId, phase: "committed", baseVersion: inspected.version,
        targetVersion: result.version, operationCount: risk.operationCount,
        operationIndex: operationApproval ? operationIndex : null,
        nextOperationIndex: operationApproval ? operationIndex + 1 : patch.operations.length,
        summary: patch.summary,
        risk: riskReceipt(risk), diff: previewSummary(preview, patch, impact), validation: validationReceipt({ ...boundedValidation(result.diagnostics), worker: this.patchWorker ? { status: "committed", isolation: "dedicated-map-ai-worker" } : { status: "main-process-fallback", isolation: "bounded-local-validation" } }),
        ...(transaction ? { transaction: { fileCount: transaction.files?.length || 0, totalBytes: transaction.totalBytes } } : {}),
        ...(revision ? { revision } : {}),
        ...(revisionError ? { revisionError } : {}),
      });
      const nextIndex = operationApproval ? operationIndex + 1 : patch.operations.length;
      if (nextIndex < (planValue(contract.plan).operations?.length || 0)) {
        return this.taskStore.snapshot({ taskId, identity });
      }
      return this.taskStore.succeed({ identity, taskId, summary: patch.summary });
    } catch (error) {
      if (error?.code === "map-version-conflict" || error?.code === "map-save-post-commit-conflict") {
        return this.taskStore.conflict({ identity, taskId, code: "MAP_AI_TASK_VERSION_CONFLICT", message: error.message });
      }
      return this.settleExecutionFailure({ identity, taskId, error, fallbackCode: "MAP_AI_TASK_EXECUTION_FAILED", fallbackMessage: "托管地图任务执行失败" });
    } finally {
      if (workerLease?.dispose) await workerLease.dispose().catch(() => {});
      if (revisionStage && this.revisionStore) await this.revisionStore.disposeStaged(revisionStage).catch(() => {});
      if (save?.id && saveIdentity) {
        await this.saveSessions.abort({ saveId: save.id, identity: saveIdentity, documentKind: "map" }).catch(() => {});
      }
    }
  }

  async authorizeLive({ taskId, identity, authority, context, protectedBaselineDocument = null }) {
    const task = this.taskStore.executionContract({ taskId, identity });
    // `pauseRequested` is an after-current-batch request.  A running batch
    // may finish its already-authorized atomic save, after which the durable
    // checkpoint moves the task to `paused`.  Cancellation and human
    // takeover, in contrast, are hard stops at every live boundary.
    if (task.controlMode === "human" || ["cancel_requested", "canceled"].includes(task.status)) {
      throw executorError(409, "MAP_AI_TASK_CONTROL_CHANGED", "托管任务已取消或被人工接管");
    }
    if (task.expiresAt <= this.now()) throw executorError(409, "MAP_AI_TASK_EXPIRED", "托管授权已过期");
    const currentAuthority = this.authorizationStore.taskContract({
      authorizationId: authority.id,
      identity,
    });
    assertAuthorityMatches(authorityForTask(authority), currentAuthority);
    const effectiveProtectedTargets = protectedTargetsForAuthority(currentAuthority);
    if (protectedBaselineDocument && effectiveProtectedTargets.length) {
      const currentSource = await readBoundedUtf8(context.targetPath, this.maxReadBytes, this.readFile);
      const currentDocument = parseTiledDocument(currentSource, { expectedKind: "map", sourcePath: authority.scope.mapPaths[0] }).document;
      assertProtectedTargetsUnchanged(
        protectedBaselineDocument,
        currentDocument,
        effectiveProtectedTargets,
        authority.scope.mapPaths[0],
      );
    }
    await this.authorize({ authority: currentAuthority, task, context });
  }

  /** Treat an observed Thread handoff as cancellation, not as a generic
   * execution failure. This closes the small race between authorization
   * transfer persistence and the task-store cancellation sweep. */
  async settleExecutionFailure({ identity, taskId, error, fallbackCode, fallbackMessage }) {
    if (error?.code === "MAP_AI_AUTHORITY_MISMATCH") {
      try {
        const task = this.taskStore.executionContract({ taskId, identity });
        const current = this.authorizationStore.taskContract({
          authorizationId: task.authority.managedAuthorizationId,
          identity,
        });
        if (current.scope.threadId !== task.authority.threadId) {
          await this.taskStore.transition({
            identity,
            taskId,
            action: "cancel",
            reason: "托管授权已转交到新 Thread，旧 Thread 任务已停止",
            errorCode: "MAP_AI_TASK_CANCELLED",
            errorMessage: "托管授权已转交到新 Thread，旧 Thread 任务已停止",
          });
          return this.taskStore.fail({
            identity,
            taskId,
            code: "MAP_AI_TASK_CANCELLED",
            message: "托管授权已转交到新 Thread，旧 Thread 任务已停止",
          });
        }
      } catch {
        // The transfer route may already have made the task terminal. Let the
        // task store's idempotent terminal handling decide the final result.
      }
    }
    return this.taskStore.fail({
      identity,
      taskId,
      code: error?.code || fallbackCode,
      message: error?.message || fallbackMessage,
    });
  }

  /**
   * Execute an explicit multi-map plan as one project transaction. Every map
   * is parsed and staged first; no target is replaced until all candidates,
   * versions, runtime checks, and live authorization checks pass.
   */
  async executeMultiMapPlan({ contract, identity, authority, taskId, effectiveProtectedTargets }) {
    if (!this.projectResourceWriter) {
      return this.taskStore.fail({ identity, taskId, code: "MAP_AI_MULTI_MAP_TRANSACTION_UNAVAILABLE", message: "多地图托管事务写入器当前不可用，未修改任何地图" });
    }
    const plan = normalizeMultiMapPlan(contract.plan, authority.scope.mapPaths);
    const maxReadBytes = boundedReadLimit(contract.settingsSnapshot?.maxMapReadBytes, this.maxReadBytes);
    const candidates = [];
    const saves = [];
    const saveIdentity = { ...identity, editorInstanceId: `managed-${taskId.slice(0, 96)}` };
    const batchId = crypto.randomBytes(18).toString("base64url");
    try {
      const multiRisk = { ruleVersion: "map-risk-v1", riskLevel: "high", reasonCodes: ["multiple_maps", "multiple_files"], hardBlocks: [] };
      if (contract.approvalSnapshot.policy !== "full_authorization" && !contract.approvalOverride) {
        await this.taskStore.recordCheckpoint({
          identity, taskId, batchId, phase: "awaiting_approval",
          baseVersion: authority.scope.mapVersions[authority.scope.mapPaths[0]],
          targetVersion: authority.scope.mapVersions[authority.scope.mapPaths[0]],
          baseVersions: authority.scope.mapVersions,
          targetVersions: authority.scope.mapVersions,
          operationCount: contract.planSummary.operationCount,
          operationIndex: 0,
          nextOperationIndex: 0,
          summary: plan.summary,
          risk: multiRisk,
          diff: { kind: "multi-map", mapCount: plan.maps.length, maps: plan.maps.map((entry) => ({ mapPath: entry.mapPath, operationCount: entry.patch.operations.length })) },
          validation: { stage: "candidate-preview", worker: { status: "not-started", isolation: "dedicated-map-ai-worker" } },
        });
        return this.taskStore.snapshot({ taskId, identity });
      }
      const currentVersions = {};
      for (const entry of plan.maps) {
        const targetPath = await resolveManagedMapTarget(authority.scope.projectPath, entry.mapPath);
        const inspected = await inspectMapFile(targetPath, { maxBytes: maxReadBytes });
        const expected = authority.scope.mapVersions[entry.mapPath];
        if (inspected.version !== expected || inspected.version !== entry.base.mapVersion) {
          return this.taskStore.conflict({ identity, taskId, code: "MAP_AI_TASK_VERSION_CONFLICT", message: `地图 ${entry.mapPath} 版本已变化 (${inspected.version}/${expected}/${entry.base.mapVersion})` });
        }
        currentVersions[entry.mapPath] = inspected.version;
        const runtimeCapabilities = await inspectMapRuntimeCapabilities({ projectPath: authority.scope.projectPath, mapPath: entry.mapPath });
        const source = await readBoundedUtf8(targetPath, maxReadBytes, this.readFile);
        const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: entry.mapPath });
        const patch = parsePlanPatch(entry.patch, { mapPath: entry.mapPath, mapVersion: inspected.version });
        assertMapPatchRuntimeCompatible(parsed.document, patch, runtimeCapabilities);
        const protectedSource = effectiveProtectedTargets.length
          ? parsed.document
          : null;
        if (protectedSource) {
          const violations = findProtectedOperationViolations(protectedSource, patch, effectiveProtectedTargets, entry.mapPath);
          if (violations.length) return this.taskStore.fail({ identity, taskId, code: "MAP_AI_PROTECTED_OPERATION", message: violations[0].message });
        }
        let workerLease;
        if (this.patchWorker) {
          workerLease = await this.patchWorker({
            id: `${taskId}-map-${candidates.length}`,
            mode: "apply",
            projectPath: authority.scope.projectPath,
            targetPath,
            mapPath: entry.mapPath,
            expectedVersion: inspected.version,
            maxReadBytes,
            plan: planWithBaseVersion(entry.patch, inspected.version),
            memoryMb: managedWorkerSetting(contract.settingsSnapshot, "memoryMb"),
            timeoutMs: managedWorkerSetting(contract.settingsSnapshot, "timeoutMs"),
            protectedTargets: effectiveProtectedTargets,
            runtimeCapabilities,
          });
          candidates.push({ entry, targetPath, inspected, candidatePath: workerLease.candidate.path, size: workerLease.candidate.size, sha256: workerLease.candidate.sha256, workerLease });
        } else {
          const prepared = prepareTiledAiPatchFills(parsed.document, patch);
          const editor = new TiledEditDocument(parsed.document);
          applyTiledAiPatch(editor, patch, { fillResults: prepared.fillResults, label: `托管 AI：${entry.mapPath}` });
          const bytes = Buffer.from(serializeTiledDocument(editor.exportDocument(), { expectedKind: "map", sourcePath: entry.mapPath, space: 2, trailingNewline: true }));
          candidates.push({ entry, targetPath, inspected, bytes, size: bytes.length, sha256: sha256(bytes), workerLease: null });
        }
      }
      const authorizeLive = async () => {
        const fresh = this.taskStore.executionContract({ taskId, identity });
        if (fresh.controlMode === "human" || ["cancel_requested", "canceled"].includes(fresh.status)) throw executorError(409, "MAP_AI_TASK_CONTROL_CHANGED", "托管任务已取消或被人工接管");
        const currentAuthority = this.authorizationStore.taskContract({ authorizationId: authority.id, identity });
        assertAuthorityMatches(authorityForTask(authority), currentAuthority);
        for (const entry of plan.maps) {
          const targetPath = await resolveManagedMapTarget(authority.scope.projectPath, entry.mapPath);
          const current = await inspectMapFile(targetPath, { maxBytes: maxReadBytes });
          if (current.version !== authority.scope.mapVersions[entry.mapPath]) throw executorError(409, "MAP_AI_TASK_VERSION_CONFLICT", `地图 ${entry.mapPath} 版本在事务边界发生变化`);
        }
      };
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const save = await this.saveSessions.begin({
          identity: saveIdentity,
          mapContext: { mapSessionId: `managed-task-${taskId}-${candidate.entry.mapPath}`, projectPath: authority.scope.projectPath, targetPath: candidate.targetPath, relativePath: candidate.entry.mapPath, documentKind: "map", version: candidate.inspected.version, writable: true },
          expectedVersion: candidate.inspected.version,
          totalBytes: candidate.size,
          totalHash: candidate.sha256,
          clientOperationId: `managed-save-${taskId}-${candidateIndex}`,
          config: { chunkBytes: this.chunkBytes },
        });
        saves.push(save);
        for (let index = 0; index < save.chunkCount; index += 1) {
          const start = index * save.config.chunkBytes;
          const end = Math.min(save.totalBytes, start + save.config.chunkBytes);
          const chunk = candidate.bytes ? candidate.bytes.subarray(start, end) : await readFileRange(candidate.candidatePath, start, end - start);
          await this.saveSessions.uploadChunk({ saveId: save.id, identity: saveIdentity, documentKind: "map", index, source: chunk, contentLength: chunk.byteLength, chunkHash: sha256(chunk) });
        }
        candidate.save = save;
        candidate.prepared = await this.saveSessions.prepareCandidate({ saveId: save.id, identity: saveIdentity, documentKind: "map", authorize: authorizeLive });
      }
      await authorizeLive();
      const transaction = await this.projectResourceWriter.saveTransaction({
        projectPath: authority.scope.projectPath,
        resourceRoots: [""],
        validateReferences: true,
        validate: authorizeLive,
        files: candidates.map((candidate) => ({ relativePath: candidate.entry.mapPath, candidatePath: candidate.prepared.candidatePath, candidateSize: candidate.prepared.size, candidateSha256: candidate.prepared.sha256, expectedVersion: candidate.prepared.expectedVersion })),
      });
      const results = [];
      for (let index = 0; index < candidates.length; index += 1) {
        results.push(await this.saveSessions.finalizeCandidate({ saveId: saves[index].id, identity: saveIdentity, documentKind: "map", candidate: candidates[index].prepared, published: transaction.files[index] }));
      }
      const targetVersions = Object.fromEntries(candidates.map((candidate, index) => [candidate.entry.mapPath, results[index].version]));
      await this.taskStore.recordCheckpoint({ identity, taskId, batchId, phase: "committed", baseVersion: authority.scope.mapVersions[authority.scope.mapPaths[0]], targetVersion: targetVersions[authority.scope.mapPaths[0]], baseVersions: currentVersions, targetVersions, operationCount: plan.maps.reduce((sum, entry) => sum + entry.patch.operations.length, 0), nextOperationIndex: plan.maps.length, summary: plan.summary, risk: multiRisk, diff: { kind: "multi-map", mapCount: plan.maps.length, maps: plan.maps.map((entry) => ({ mapPath: entry.mapPath, operationCount: entry.patch.operations.length })) }, validation: { stage: "committed", worker: this.patchWorker ? { status: "committed", isolation: "dedicated-map-ai-worker" } : { status: "main-process-fallback", isolation: "bounded-local-validation" }, transaction: { fileCount: transaction.files.length, totalBytes: transaction.totalBytes } } });
      return this.taskStore.succeed({ identity, taskId, summary: plan.summary });
    } catch (error) {
      return this.settleExecutionFailure({ identity, taskId, error, fallbackCode: "MAP_AI_MULTI_MAP_FAILED", fallbackMessage: "多地图事务执行失败" });
    } finally {
      for (const candidate of candidates) if (candidate.workerLease?.dispose) await candidate.workerLease.dispose().catch(() => {});
      for (const save of saves) await this.saveSessions.abort({ saveId: save.id, identity: saveIdentity, documentKind: "map" }).catch(() => {});
    }
  }

  /**
   * Publish a bounded set of TMJ/TSJ/TX/World/image candidates as one project
   * transaction. Candidate ids are resolved only inside the server and are
   * held by leases until the transaction has either committed or rolled back.
   */
  async executeResourcePatchPlan({ contract, identity, authority, taskId }) {
    if (!authority.allowedOps?.some((operation) => ["apply_tiled_resource_patch", "apply_project_patch"].includes(operation))) {
      return this.taskStore.fail({ identity, taskId, code: "MAP_AI_RESOURCE_OPERATION_NOT_ALLOWED", message: "当前托管授权不允许资源补丁写入" });
    }
    if (!this.projectResourceWriter || !this.resourceCandidateStore) {
      return this.taskStore.fail({ identity, taskId, code: "MAP_AI_RESOURCE_TRANSACTION_UNAVAILABLE", message: "地图资源托管事务当前不可用，未修改任何文件" });
    }
    const taskAuthority = contract.authority || {};
    const authorizedFiles = taskAuthority.projectWide
      ? (taskAuthority.targetFiles || [])
      : (authority.scope.targetFiles || []);
    const plan = normalizeResourcePatchPlan(contract.plan, authorizedFiles, { projectWide: taskAuthority.projectWide === true || authority.scope.projectWide === true });
    const maxReadBytes = boundedReadLimit(contract.settingsSnapshot?.maxMapReadBytes, this.maxReadBytes);
    const maxResourceBytes = boundedResourceLimit(contract.settingsSnapshot?.maxResourceBytes, DEFAULT_MAX_RESOURCE_BYTES);
    const batchId = crypto.randomBytes(18).toString("base64url");
    const resolved = [];
    const currentVersions = {};
    const mainMapPath = taskAuthority.mapPath || taskAuthority.mapPaths?.[0] || authority.scope.mapPaths?.[0] || plan.files[0].relativePath;
    const mainBaseVersion = taskAuthority.baseVersion || taskAuthority.mapVersions?.[mainMapPath] || authority.scope.mapVersions?.[mainMapPath] || plan.files[0].baseVersion;
    try {
      for (const file of plan.files) {
        if (!taskAuthority.projectWide && !authority.scope.targetFiles.includes(file.relativePath)) {
          throw executorError(403, "MAP_AI_RESOURCE_SCOPE_MISMATCH", `资源 ${file.relativePath} 不在托管授权范围`);
        }
        const targetPath = await resolveManagedResourceTarget(authority.scope.projectPath, file.relativePath);
        const current = await inspectOptionalManagedResource(targetPath, maxResourceBytes);
        const expected = taskAuthority.targetFileVersions?.[file.relativePath]
          ?? authority.scope.targetFileVersions?.[file.relativePath]
          ?? file.baseVersion;
        if (expected !== file.baseVersion || (current?.version || null) !== file.baseVersion) {
          return this.taskStore.conflict({ identity, taskId, code: "MAP_AI_TASK_VERSION_CONFLICT", message: `资源 ${file.relativePath} 基础版本已变化，未提交任何文件` });
        }
        currentVersions[file.relativePath] = current?.version || null;
        const candidate = await this.resourceCandidateStore.resolve({
          candidateId: file.candidateId,
          userId: identity.userId,
          projectPath: authority.scope.projectPath,
          threadId: taskAuthority.threadId || authority.scope.threadId,
          projectWide: taskAuthority.projectWide === true || authority.scope.projectWide === true,
          relativePath: file.relativePath,
          baseVersion: file.baseVersion,
        });
        if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size !== candidate.metadata.size)) throw executorError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", `资源 ${file.relativePath} 候选大小不一致`);
        if (file.sha256 !== undefined && (!SHA256.test(file.sha256) || file.sha256 !== candidate.metadata.sha256)) throw executorError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", `资源 ${file.relativePath} 候选哈希不一致`);
        resolved.push({ file, targetPath, candidate });
      }
      const risk = {
        ruleVersion: "map-risk-v1",
        riskLevel: "high",
        reasonCodes: ["multiple_files", "resource_dependency_transaction"],
        hardBlocks: [],
      };
      if (contract.approvalSnapshot.policy !== "full_authorization" && !contract.approvalOverride) {
        await this.taskStore.recordCheckpoint({
          identity, taskId, batchId, phase: "awaiting_approval",
          baseVersion: mainBaseVersion,
          targetVersion: mainBaseVersion,
          baseVersions: currentVersions,
          targetVersions: Object.fromEntries(Object.keys(currentVersions).filter((key) => currentVersions[key] !== null).map((key) => [key, currentVersions[key]])),
          operationCount: plan.files.length, operationIndex: 0, nextOperationIndex: 0,
          summary: plan.summary, risk,
          diff: { kind: "resource-transaction", fileCount: plan.files.length, files: plan.files.map(({ relativePath, baseVersion }) => ({ relativePath, baseVersion })) },
          validation: { stage: "candidate-preview", worker: { status: "not-started", isolation: "dedicated-resource-transaction" } },
        });
        return this.taskStore.snapshot({ taskId, identity });
      }
      await this.taskStore.recordCheckpoint({
        identity, taskId, batchId, phase: "started",
        baseVersion: mainBaseVersion,
        targetVersion: mainBaseVersion,
        baseVersions: currentVersions,
        targetVersions: Object.fromEntries(Object.keys(currentVersions).filter((key) => currentVersions[key] !== null).map((key) => [key, currentVersions[key]])),
        operationCount: plan.files.length, operationIndex: 0, nextOperationIndex: 0,
        summary: plan.summary, risk,
        diff: { kind: "resource-transaction", fileCount: plan.files.length, files: plan.files.map(({ relativePath, baseVersion }) => ({ relativePath, baseVersion })) },
        validation: { stage: "candidate-preview", worker: { status: "started", isolation: "dedicated-resource-transaction" } },
      });
      const authorizeLive = async () => {
        const fresh = this.taskStore.executionContract({ taskId, identity });
        if (fresh.controlMode === "human" || ["cancel_requested", "canceled"].includes(fresh.status)) throw executorError(409, "MAP_AI_TASK_CONTROL_CHANGED", "托管任务已取消或被人工接管");
        if (fresh.expiresAt <= this.now()) throw executorError(409, "MAP_AI_TASK_EXPIRED", "托管授权已过期");
        const currentAuthority = this.authorizationStore.taskContract({ authorizationId: authority.id, identity });
        assertAuthorityMatches(authorityForTask(authority), currentAuthority);
        for (const file of plan.files) {
          const targetPath = await resolveManagedResourceTarget(authority.scope.projectPath, file.relativePath);
          const current = await inspectOptionalManagedResource(targetPath, maxResourceBytes);
        if ((current?.version || null) !== file.baseVersion) throw executorError(409, "MAP_AI_TASK_VERSION_CONFLICT", `资源 ${file.relativePath} 在事务边界发生变化`);
        }
        await this.authorize({ authority: currentAuthority, task: fresh, context: { projectPath: authority.scope.projectPath, relativePaths: plan.files.map((entry) => entry.relativePath), writable: true } });
      };
      await authorizeLive();
      const transaction = await this.projectResourceWriter.saveTransaction({
        projectPath: authority.scope.projectPath,
        resourceRoots: [""],
        validateReferences: true,
        validate: authorizeLive,
        files: resolved.map(({ file, candidate }) => ({
          relativePath: file.relativePath,
          candidatePath: candidate.candidatePath,
          candidateSize: candidate.metadata.size,
          candidateSha256: candidate.metadata.sha256,
          expectedVersion: file.baseVersion,
        })),
      });
      const targetVersions = Object.fromEntries(transaction.files.map((file) => [file.relativePath, file.version]));
      const mainTargetVersion = targetVersions[mainMapPath] || mainBaseVersion;
      await this.taskStore.recordCheckpoint({
        identity, taskId, batchId, phase: "committed",
        baseVersion: mainBaseVersion, targetVersion: mainTargetVersion,
        baseVersions: currentVersions, targetVersions,
        operationCount: plan.files.length, operationIndex: 0, nextOperationIndex: plan.files.length,
        summary: plan.summary, risk,
        diff: { kind: "resource-transaction", fileCount: transaction.files.length, files: transaction.files.map(({ relativePath, version, size }) => ({ relativePath, version, size })) },
        validation: { stage: "committed", worker: { status: "committed", isolation: "dedicated-resource-transaction" }, transaction: { fileCount: transaction.files.length, totalBytes: transaction.totalBytes } },
      });
      return this.taskStore.succeed({ identity, taskId, summary: plan.summary });
    } catch (error) {
      return this.settleExecutionFailure({ identity, taskId, error, fallbackCode: "MAP_AI_RESOURCE_TRANSACTION_FAILED", fallbackMessage: "地图资源托管事务失败" });
    } finally {
      await Promise.all(resolved.map(({ candidate }) => candidate.release?.().catch(() => {})));
    }
  }

  async executeRevisionRestore({ contract, identity, authority, targetPath, inspected, taskId, batchId, protectedBaselineDocument = null, effectiveProtectedTargets = [] }) {
    const policy = contract.approvalSnapshot?.policy || "ask_each";
    const revisionId = contract.settingsSnapshot?.restoreRevisionId || contract.plan?.revisionId;
    const revision = this.revisionStore.get({ revisionId, projectPath: authority.scope.projectPath, relativePath: authority.scope.mapPaths[0] });
    const risk = { ruleVersion: "map-risk-v1", riskLevel: "high", reasonCodes: ["revision_restore"], hardBlocks: [], operationCount: 1 };
    if (policy !== "full_authorization" && !contract.approvalOverride) {
      await this.taskStore.recordCheckpoint({
        identity, taskId, batchId, phase: "awaiting_approval", baseVersion: inspected.version, targetVersion: inspected.version,
        operationCount: 1, operationIndex: 0, nextOperationIndex: 0, summary: `恢复地图修订 ${revision.id}`,
        risk, diff: { kind: "map-revision-restore", revision: { id: revision.id, version: revision.version, size: revision.size } },
        validation: { stage: "revision-selected", worker: { status: "not-started", isolation: "dedicated-map-ai-worker" } },
      });
      return this.taskStore.snapshot({ taskId, identity });
    }
    if (revision.version === inspected.version) return this.taskStore.fail({ identity, taskId, code: "MAP_AI_REVISION_ALREADY_CURRENT", message: "目标修订已经是当前地图版本" });
    const materialized = await this.revisionStore.materialize({ revisionId: revision.id, projectPath: authority.scope.projectPath, relativePath: authority.scope.mapPaths[0] });
    let save = null;
    let saveIdentity = null;
    let beforeStage = null;
    try {
      if (protectedBaselineDocument) {
        const revisionSource = await readBoundedUtf8(materialized.candidatePath, this.maxReadBytes, this.readFile);
        const revisionDocument = parseTiledDocument(revisionSource, {
          expectedKind: "map",
          sourcePath: authority.scope.mapPaths[0],
        }).document;
        assertProtectedTargetsUnchanged(
          protectedBaselineDocument,
          revisionDocument,
          effectiveProtectedTargets,
          authority.scope.mapPaths[0],
        );
      }
      beforeStage = await this.revisionStore.stageCurrent({ projectPath: authority.scope.projectPath, relativePath: authority.scope.mapPaths[0], targetPath, expectedVersion: inspected.version, reason: "managed-restore-before", actor: { userId: identity.userId, taskId } });
      saveIdentity = { ...identity, editorInstanceId: `managed-${taskId.slice(0, 96)}` };
      save = await this.saveSessions.begin({ identity: saveIdentity, mapContext: { mapSessionId: `managed-task-${taskId}`, projectPath: authority.scope.projectPath, targetPath, relativePath: authority.scope.mapPaths[0], documentKind: "map", version: inspected.version, writable: true }, expectedVersion: inspected.version, totalBytes: revision.size, totalHash: revision.version, clientOperationId: `managed-restore-${taskId}-${inspected.version}`, config: { chunkBytes: this.chunkBytes } });
      const handle = await fs.open(materialized.candidatePath, "r");
      try {
        for (let index = 0; index < save.chunkCount; index += 1) {
          const start = index * save.config.chunkBytes;
          const size = Math.min(save.config.chunkBytes, save.totalBytes - start);
          const buffer = Buffer.allocUnsafe(size);
          let offset = 0;
          while (offset < size) { const read = await handle.read(buffer, offset, size - offset, start + offset); if (!read.bytesRead) throw executorError(409, "MAP_AI_REVISION_BLOB_INVALID", "地图修订内容不完整"); offset += read.bytesRead; }
          await this.saveSessions.uploadChunk({ saveId: save.id, identity: saveIdentity, documentKind: "map", index, source: buffer, contentLength: size, chunkHash: sha256(buffer) });
        }
      } finally { await handle.close(); }
      // The historical document was checked once before staging.  Re-check
      // the same protected baseline at both candidate preparation and the
      // project transaction validation boundary; otherwise a human edit made
      // while the revision is being materialized could be overwritten by the
      // restore even though the initial comparison passed.
      const authorizeLive = (context) => this.authorizeLive({
        taskId,
        identity,
        authority,
        context,
        protectedBaselineDocument,
      });
      const candidate = await this.saveSessions.prepareCandidate({ saveId: save.id, identity: saveIdentity, documentKind: "map", authorize: authorizeLive });
      const transaction = await this.projectResourceWriter.saveTransaction({ projectPath: authority.scope.projectPath, resourceRoots: [""], validateReferences: true, validate: async () => authorizeLive({ projectPath: authority.scope.projectPath, targetPath, relativePath: authority.scope.mapPaths[0], version: inspected.version, writable: true }), files: [{ relativePath: authority.scope.mapPaths[0], candidatePath: candidate.candidatePath, candidateSize: candidate.size, candidateSha256: candidate.sha256, expectedVersion: candidate.expectedVersion }] });
      const result = await this.saveSessions.finalizeCandidate({ saveId: save.id, identity: saveIdentity, documentKind: "map", candidate, published: transaction.files?.[0] });
      const createdRevision = await this.revisionStore.commitStaged(beforeStage);
      beforeStage = null;
      await this.taskStore.recordCheckpoint({ identity, taskId, batchId, phase: "committed", baseVersion: inspected.version, targetVersion: result.version, operationCount: 1, operationIndex: 0, nextOperationIndex: 1, summary: `恢复地图修订 ${revision.id}`, risk, diff: { kind: "map-revision-restore", revision: { id: revision.id, version: revision.version }, createdRevision }, validation: { stage: "committed", worker: { status: "committed", isolation: "dedicated-map-save-worker" } } });
      return this.taskStore.succeed({ identity, taskId, summary: `已恢复地图修订 ${revision.id}` });
    } finally {
      await this.revisionStore.disposeStaged(beforeStage).catch(() => {});
      await this.revisionStore.disposeStaged(materialized).catch(() => {});
      if (save?.id && saveIdentity) await this.saveSessions.abort({ saveId: save.id, identity: saveIdentity, documentKind: "map" }).catch(() => {});
    }
  }
}

function parsePlanPatch(plan, expected) {
  const value = plan?.patch && typeof plan.patch === "object" ? plan.patch : plan;
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.format) {
    throw executorError(422, "MAP_AI_TASK_PLAN_INVALID", "托管计划必须是 wfl-tiled-patch 结构化补丁");
  }
  const base = {
    ...value.base,
    editorStateId: Number(value.base?.editorStateId ?? 0),
  };
  return parseTiledAiPatch(JSON.stringify({ ...value, base }), {
    mapPath: expected.mapPath,
    mapVersion: expected.mapVersion,
    editorStateId: base.editorStateId,
  });
}

function isMultiMapPlan(plan) {
  const value = plan?.patch && typeof plan.patch === "object" ? plan.patch : plan;
  return value?.format === "wfl-multi-map-patch" && value?.version === 1 && Array.isArray(value.maps);
}

function isResourcePatchPlan(plan) {
  const value = plan?.patch && typeof plan.patch === "object" ? plan.patch : plan;
  return value?.format === "wfl-tiled-resource-patch" && value?.version === 1 && Array.isArray(value.files);
}

function normalizeResourcePatchPlan(plan, authorizedFiles, { projectWide = false } = {}) {
  const value = planValue(plan);
  if (!isResourcePatchPlan(value) || value.files.length < 1 || value.files.length > 256) {
    throw executorError(422, "MAP_AI_RESOURCE_PATCH_INVALID", "资源托管计划必须包含 1 到 256 个文件");
  }
  const patchKeys = new Set(["format", "version", "summary", "files"]);
  if (Object.keys(value).some((key) => !patchKeys.has(key))) {
    throw executorError(400, "MAP_AI_RESOURCE_PATCH_INVALID", "资源托管计划包含未知字段");
  }
  const allowed = new Set(authorizedFiles || []);
  if (!allowed.size && !projectWide) throw executorError(403, "MAP_AI_RESOURCE_SCOPE_MISMATCH", "当前托管授权没有资源范围");
  const seen = new Set();
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw executorError(422, "MAP_AI_RESOURCE_PATCH_INVALID", "资源托管计划文件条目无效");
    }
    const fileKeys = new Set(["path", "baseVersion", "candidateId", "size", "sha256"]);
    if (Object.keys(entry).some((key) => !fileKeys.has(key))) {
      throw executorError(400, "MAP_AI_RESOURCE_PATCH_INVALID", "资源托管计划文件条目包含未知字段");
    }
    const relativePath = normalizeManagedResourcePath(entry?.path || entry?.relativePath);
    if ((!projectWide && !allowed.has(relativePath)) || seen.has(relativePath)) throw executorError(403, "MAP_AI_RESOURCE_SCOPE_MISMATCH", `资源 ${relativePath} 不在托管授权范围或重复提交`);
    seen.add(relativePath);
    const baseVersion = entry.baseVersion === null ? null : String(entry.baseVersion || "").toLowerCase();
    if (baseVersion !== null && !SHA256.test(baseVersion)) throw executorError(422, "MAP_AI_RESOURCE_PATCH_VERSION_INVALID", `资源 ${relativePath} 基础版本无效`);
    if (typeof entry.candidateId !== "string" || !entry.candidateId.trim()) throw executorError(422, "MAP_AI_RESOURCE_PATCH_CANDIDATE_INVALID", `资源 ${relativePath} 缺少候选标识`);
    if (entry.size !== undefined && (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) <= 0)) throw executorError(422, "MAP_AI_RESOURCE_PATCH_SIZE_INVALID", `资源 ${relativePath} 大小无效`);
    if (entry.sha256 !== undefined && !SHA256.test(String(entry.sha256))) throw executorError(422, "MAP_AI_RESOURCE_PATCH_HASH_INVALID", `资源 ${relativePath} 哈希无效`);
    return {
      relativePath,
      baseVersion,
      candidateId: entry.candidateId,
      ...(entry.size === undefined ? {} : { size: Number(entry.size) }),
      ...(entry.sha256 === undefined ? {} : { sha256: String(entry.sha256).toLowerCase() }),
    };
  });
  return { format: "wfl-tiled-resource-patch", version: 1, summary: String(value.summary || "地图资源托管修改").slice(0, 2_000), files };
}

function normalizeManagedResourcePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^(?:[a-z][a-z0-9+.-]*:)/iu.test(value)) throw executorError(400, "MAP_AI_RESOURCE_PATH_INVALID", "资源路径必须是工程相对路径");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw executorError(400, "MAP_AI_RESOURCE_PATH_INVALID", "资源路径无效");
  if (!/(?:\.(?:tmj|tsj|tx|world|png|jpe?g|webp)|\.character\.json)$/iu.test(normalized)) throw executorError(415, "MAP_AI_RESOURCE_KIND_INVALID", `资源类型不受支持: ${normalized}`);
  return normalized;
}

async function resolveManagedResourceTarget(projectPath, relativePath) {
  const root = await fs.realpath(projectPath);
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw executorError(403, "MAP_AI_TARGET_OUTSIDE_PROJECT", "托管资源不在授权工程内");
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (stat?.isSymbolicLink()) throw executorError(403, "MAP_AI_TARGET_SYMLINK_OR_INVALID", "托管资源路径包含符号链接");
  }
  return target;
}

async function inspectOptionalManagedResource(targetPath, maxBytes) {
  const stat = await fs.lstat(targetPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw executorError(413, "MAP_AI_RESOURCE_TOO_LARGE", "托管资源无效或超过读取预算");
  return { version: await hashFilePath(targetPath), size: stat.size };
}

async function hashFilePath(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeMultiMapPlan(plan, authorizedMapPaths) {
  const value = plan?.patch && typeof plan.patch === "object" ? plan.patch : plan;
  if (!isMultiMapPlan(value) || value.maps.length < 2 || value.maps.length > 128) {
    throw executorError(422, "MAP_AI_MULTI_MAP_PLAN_INVALID", "多地图托管计划必须包含 2 到 128 张地图");
  }
  const allowed = new Set(authorizedMapPaths || []);
  const seen = new Set();
  const maps = value.maps.map((entry, index) => {
    const mapPath = String(entry?.mapPath || entry?.base?.mapPath || "");
    if (!allowed.has(mapPath) || seen.has(mapPath)) throw executorError(403, "MAP_AI_MULTI_MAP_SCOPE_MISMATCH", `地图 ${mapPath || index} 不在托管授权范围`);
    seen.add(mapPath);
    const nestedBase = entry?.patch?.base && typeof entry.patch.base === "object" ? entry.patch.base : {};
    const base = entry?.base && typeof entry.base === "object" ? entry.base : nestedBase;
    const patch = entry?.patch && typeof entry.patch === "object" ? { ...entry.patch, base: { ...entry.patch.base, ...base, mapPath } } : entry?.patch;
    return { mapPath, base: { ...base, mapPath }, patch };
  });
  if (seen.size !== allowed.size && allowed.size > 1) throw executorError(403, "MAP_AI_MULTI_MAP_SCOPE_MISMATCH", "多地图计划必须覆盖全部授权地图");
  return { format: "wfl-multi-map-patch", version: 1, summary: String(value.summary || "多地图托管修改").slice(0, 2_000), maps };
}

function planValue(plan) {
  const value = plan?.patch && typeof plan.patch === "object" ? plan.patch : plan;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executorError(422, "MAP_AI_TASK_PLAN_INVALID", "托管计划必须是结构化对象");
  }
  return value;
}

function planWithBaseVersion(plan, mapVersion, operations = null) {
  const value = planValue(plan);
  return {
    ...value,
    base: { ...value.base, mapVersion },
    ...(operations ? { operations } : {}),
  };
}

function managedWorkerSetting(snapshot, key) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  const worker = value.worker && typeof value.worker === "object" ? value.worker : {};
  const configWorker = value.config?.worker && typeof value.config.worker === "object" ? value.config.worker : {};
  return value[`worker${key[0].toUpperCase()}${key.slice(1)}`]
    ?? worker[key]
    ?? configWorker[key]
    ?? null;
}

function patchRiskShape(plan) {
  const value = planValue(plan);
  if (value.format !== "wfl-tiled-patch" || value.version !== 1 || !Array.isArray(value.operations)) {
    throw executorError(422, "MAP_AI_TASK_PLAN_INVALID", "托管计划必须是 wfl-tiled-patch v1");
  }
  return {
    summary: String(value.summary || "地图 AI 托管补丁").slice(0, 2_000),
    operations: value.operations,
  };
}

function previewPatch(document, patch) {
  const preview = previewTiledAiPatch(document, patch);
  return {
    ...preview,
    ordinaryObjectCount: patch.operations.filter((entry) => ["add-object", "update-object", "remove-object"].includes(entry.op)).length,
  };
}

function assertAuthorityMatches(authority, authorization) {
  if (authority?.projectWide === true || authorization?.scope?.projectWide === true) {
    if (authority?.projectWide !== true
      || authorization?.scope?.projectWide !== true
      || authorization?.scope?.projectPath !== authority.projectPath) {
      throw executorError(409, "MAP_AI_AUTHORITY_MISMATCH", "托管工程授权范围已变化");
    }
    if (JSON.stringify(authorization?.collaborationPolicy || null) !== JSON.stringify(authority.collaborationPolicy || null)) {
      throw executorError(409, "MAP_COLLABORATION_POLICY_CONFLICT", "协同策略已经变化，托管任务必须使用新策略重新创建");
    }
    return;
  }
  const expectedMapPaths = [...new Set(authority.mapPaths || [authority.mapPath])].sort();
  const actualMapPaths = [...new Set(authorization?.scope?.mapPaths || [])].sort();
  const expectedVersions = authority.mapVersions || { [authority.mapPath]: authority.baseVersion };
  const actualVersions = authorization?.scope?.mapVersions || {};
  if (authorization?.scope?.threadId !== authority.threadId
    || authorization?.scope?.projectPath !== authority.projectPath
    || JSON.stringify(actualMapPaths) !== JSON.stringify(expectedMapPaths)
    || expectedMapPaths.some((mapPath) => actualVersions[mapPath] !== expectedVersions[mapPath])) {
    throw executorError(409, "MAP_AI_AUTHORITY_MISMATCH", "托管任务授权范围已变化");
  }
  const expectedFiles = [...new Set(authority.targetFiles || expectedMapPaths)].sort();
  const actualFiles = [...new Set(authorization?.scope?.targetFiles || actualMapPaths)].sort();
  const expectedFileVersions = authority.targetFileVersions || {};
  const actualFileVersions = authorization?.scope?.targetFileVersions || {};
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)
    || expectedFiles.some((resourcePath) => actualFileVersions[resourcePath] !== expectedFileVersions[resourcePath])) {
    throw executorError(409, "MAP_AI_AUTHORITY_MISMATCH", "托管资源范围已变化");
  }
  if (JSON.stringify(authorization?.collaborationPolicy || null) !== JSON.stringify(authority.collaborationPolicy || null)) {
    throw executorError(409, "MAP_COLLABORATION_POLICY_CONFLICT", "协同策略已经变化，托管任务必须使用新策略重新创建");
  }
}

function protectedTargetsForAuthority(authority) {
  const explicit = Array.isArray(authority?.protectedTargets) ? authority.protectedTargets : [];
  const policy = authority?.collaborationPolicy;
  const policyTargets = policy ? collaborationPolicyProtectedTargets(policy, authority?.mapPath || policy.mapPath) : [];
  return normalizeProtectedTargets([...explicit, ...policyTargets]);
}

function authorityForTask(value) {
  const mapPaths = value.scope.mapPaths || [value.scope.mapPath];
  const mapVersions = value.scope.mapVersions || { [value.scope.mapPath]: value.scope.mapVersions?.[value.scope.mapPath] || value.scope.mapVersion };
  return {
    projectWide: value.scope.projectWide === true,
    scopeKind: value.scope.scopeKind || (value.scope.projectWide ? "project" : "map"),
    threadId: value.scope.threadId,
    projectPath: value.scope.projectPath,
    mapPath: mapPaths[0],
    baseVersion: mapVersions[mapPaths[0]],
    mapPaths,
    mapVersions,
    targetFiles: value.scope.targetFiles || mapPaths,
    targetFileVersions: value.scope.targetFileVersions || mapVersions,
    collaborationPolicy: value.collaborationPolicy || null,
  };
}

function riskReceipt(risk) {
  return {
    ruleVersion: risk.ruleVersion,
    riskLevel: risk.riskLevel,
    reasonCodes: risk.reasonCodes,
    hardBlocks: risk.hardBlocks,
  };
}

// Checkpoints are durable status records, not a second copy of a patch. Keep
// their diff receipt useful for the editor while making its size independent
// of the number of changed cells/objects in a large map.
function previewSummary(preview, patch, impact = null) {
  const entries = Array.isArray(preview?.entries) ? preview.entries : [];
  const limit = 24;
  const operationKinds = Object.create(null);
  for (const operation of Array.isArray(patch?.operations) ? patch.operations : []) {
    const key = String(operation?.op || "unknown");
    operationKinds[key] = (operationKinds[key] || 0) + 1;
  }
  return {
    ...(impact ? { impact } : {}),
    summary: boundedReceiptText(preview?.summary || patch?.summary || "地图 AI 托管补丁", 2_000),
    operationCount: Number.isSafeInteger(preview?.operationCount) ? preview.operationCount : entries.length,
    tileCellCount: Number.isSafeInteger(preview?.tileCellCount) ? preview.tileCellCount : 0,
    ordinaryObjectCount: Number.isSafeInteger(preview?.ordinaryObjectCount) ? preview.ordinaryObjectCount : 0,
    operationKinds,
    entries: entries.slice(0, limit).map((entry) => ({
      index: entry?.index,
      op: boundedReceiptText(entry?.op || "", 64),
      title: boundedReceiptText(entry?.title || "", 240),
      detail: boundedReceiptText(entry?.detail || "", 512),
    })),
    truncated: entries.length > limit,
    omittedEntries: Math.max(0, entries.length - limit),
  };
}

function boundedValidation(diagnostics) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  return {
    stage: "validated-and-committed",
    diagnosticCount: list.length,
    diagnostics: list.slice(0, 16).map((entry) => ({
      code: boundedReceiptText(entry?.code || "", 100),
      message: boundedReceiptText(entry?.message || String(entry || ""), 512),
      severity: boundedReceiptText(entry?.severity || "warning", 32),
    })),
    truncated: list.length > 16,
  };
}

function validationReceipt(value) {
  const result = value && typeof value === "object" ? value : {};
  return {
    ...result,
    stage: boundedReceiptText(result.stage || "unknown", 64),
    worker: result.worker && typeof result.worker === "object"
      ? {
          status: boundedReceiptText(result.worker.status || "unknown", 64),
          isolation: boundedReceiptText(result.worker.isolation || "unknown", 100),
        }
      : null,
  };
}

function boundedReceiptText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || !browserSessionId) throw executorError(400, "MAP_AI_TASK_IDENTITY_INVALID", "托管任务身份无效");
  return { userId, browserSessionId };
}

function sameIdentity(left, right) {
  return left?.userId === right?.userId && left?.browserSessionId === right?.browserSessionId;
}

async function resolveManagedMapTarget(projectPath, mapPath) {
  const root = await fs.realpath(projectPath);
  const candidate = path.resolve(root, ...String(mapPath).split("/"));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw executorError(403, "MAP_AI_TARGET_OUTSIDE_PROJECT", "托管地图不在授权工程内");
  }
  const [realTarget, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
  const realRelative = path.relative(root, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || stat.isSymbolicLink() || !stat.isFile()) {
    throw executorError(403, "MAP_AI_TARGET_SYMLINK_OR_INVALID", "托管地图路径无效或包含符号链接");
  }
  return candidate;
}
function positiveInteger(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function boundedReadLimit(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1_024 * 1_024 || number > 2 * 1024 * 1024 * 1024) {
    throw executorError(400, "MAP_AI_TASK_READ_LIMIT_INVALID", "托管地图读取预算无效");
  }
  return number;
}
function boundedResourceLimit(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1_024 * 1_024 || number > DEFAULT_MAX_RESOURCE_BYTES) {
    throw executorError(400, "MAP_AI_TASK_RESOURCE_LIMIT_INVALID", "托管资源读取预算无效");
  }
  return number;
}
async function readBoundedUtf8(filePath, limit, fallbackReadFile) {
  // Keep the injectable reader for deterministic unit tests, but enforce the
  // same byte budget before parsing a large managed map in the main process.
  if (fallbackReadFile !== fs.readFile) {
    const value = await fallbackReadFile(filePath, "utf8");
    if (Buffer.byteLength(value, "utf8") > limit) throw executorError(413, "MAP_AI_TASK_MAP_TOO_LARGE", "托管地图超过当前任务读取预算");
    return value;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > limit) throw executorError(413, "MAP_AI_TASK_MAP_TOO_LARGE", "托管地图超过当前任务读取预算");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function readFileRange(filename, offset, length) {
  const handle = await fs.open(filename, "r");
  const buffer = Buffer.alloc(length);
  try {
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (!result.bytesRead) throw executorError(502, "MAP_AI_WORKER_CANDIDATE_READ_FAILED", "无法读取地图 AI Worker 候选分块");
      read += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
function executorError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
