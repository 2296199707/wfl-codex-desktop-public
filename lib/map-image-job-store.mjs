import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { publishFileBatch } from "./image-atomic-save.mjs";
import { inspectImageBuffer } from "./image-file.mjs";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";
import {
  buildMapImagePublicationCompanions,
  beginMapAssetPublication,
  mapAssetTransactionJournalPath,
  recoverMapAssetPublicationTransactions,
  removeMapAssetTransactionJournal,
  writeMapAssetTransactionJournal,
} from "./map-asset-publication.mjs";

const ACTIVE = new Set(["queued", "running"]);
const FINAL = new Set(["succeeded", "failed", "canceled", "expired", "published"]);
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_JOBS = 256;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_CANDIDATE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATE_FILES = 8;
const DEFAULT_MAX_CANDIDATE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAP_ASSET_QUALITY_SCHEMA = "map-image-quality-target-v1";
const MAP_ASSET_QUALITY_REPORT_SCHEMA = "map-image-quality-report-v1";
const MAX_EDGE_MEAN_ABSOLUTE_ERROR = 16;
const MIN_EDGE_VISIBLE_COVERAGE = 0.9;
const VISIBLE_ALPHA_THRESHOLD = 16;
const MIN_PROP_BORDER_TRANSPARENT_COVERAGE = 0.5;
const TRANSPARENT_MAP_ASSET_KINDS = new Set(["plant", "prop", "tileset"]);
const MAP_ASSET_KINDS = new Set([...TRANSPARENT_MAP_ASSET_KINDS, "terrain", "background"]);
const MAP_IMAGE_REQUEST_FIELDS = Object.freeze([
  "operation", "prompt", "sourcePath", "sourcePaths", "maskPath", "outpaint", "expand",
  "n", "size", "quality", "outputFormat", "outputCompression", "background", "moderation",
  "inputFidelity", "stream", "partialImages", "maskMode", "maskFeather", "preserveSource",
  "blendMargin", "alignmentPolicy", "assetKind", "qualityTarget", "sourceCrop", "sourceSize",
]);
const RESERVED_PROJECT_SEGMENTS = new Set([
  ".git", ".codex-desktop", ".codex-runtime", ".codex-uploads", ".codex-trash",
]);

/**
 * Image jobs submitted from the map editor.  This deliberately does not call
 * the general /api/images/v2 execution path: a map job is bound to one editor
 * session/version and its output is staged as a candidate until explicitly
 * published by the user.
 */
export class MapImageJobStore extends EventEmitter {
  constructor({
    temporaryRoot,
    runner,
    authorizeSession = async () => {},
    limits = null,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxJobs = DEFAULT_MAX_JOBS,
    concurrency = DEFAULT_CONCURRENCY,
    maxCandidateBytes = DEFAULT_MAX_CANDIDATE_BYTES,
    maxCandidateFiles = DEFAULT_MAX_CANDIDATE_FILES,
    maxCandidateTotalBytes = DEFAULT_MAX_CANDIDATE_TOTAL_BYTES,
  } = {}) {
    super();
    if (typeof runner !== "function") throw new TypeError("Map image runner is required");
    this.temporaryRoot = path.resolve(String(temporaryRoot || path.join(process.cwd(), ".map-image-candidates")));
    this.runner = runner;
    this.authorizeSession = authorizeSession;
    this.limits = typeof limits === "function" ? limits : null;
    this.now = typeof now === "function" ? now : Date.now;
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxJobs = positiveInteger(maxJobs, DEFAULT_MAX_JOBS, "maxJobs");
    this.concurrency = positiveInteger(concurrency, DEFAULT_CONCURRENCY, "concurrency");
    this.maxCandidateBytes = positiveInteger(
      maxCandidateBytes,
      DEFAULT_MAX_CANDIDATE_BYTES,
      "maxCandidateBytes",
    );
    this.maxCandidateFiles = positiveInteger(
      maxCandidateFiles,
      DEFAULT_MAX_CANDIDATE_FILES,
      "maxCandidateFiles",
    );
    this.maxCandidateTotalBytes = positiveInteger(
      maxCandidateTotalBytes,
      DEFAULT_MAX_CANDIDATE_TOTAL_BYTES,
      "maxCandidateTotalBytes",
    );
    this.jobs = [];
    this.running = new Map();
    this.pumping = false;
    this.closed = false;
  }

  async initialize() {
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    this.recovery = await recoverMapAssetPublicationTransactions({ temporaryRoot: this.temporaryRoot })
      .catch((error) => ({
        recovered: 0,
        completed: 0,
        rolledBack: 0,
        failures: [{ code: String(error?.code || "MAP_ASSET_TRANSACTION_RECOVERY_FAILED") }],
      }));
    return this;
  }

  enqueue(input, { signal = null } = {}) {
    this.prune();
    if (this.closed) throw mapImageError(503, "MAP_IMAGE_QUEUE_CLOSED", "地图生图队列已关闭");
    if (signal?.aborted) throw mapImageError(499, "MAP_IMAGE_CANCELED", "地图生图任务已取消");
    if (this.jobs.filter((job) => ACTIVE.has(job.status)).length >= this.currentLimits().maxJobs) {
      throw mapImageError(429, "MAP_IMAGE_QUEUE_FULL", "地图生图排队任务已达到上限");
    }
    const identity = normalizeIdentity(input?.identity);
    const mapContext = normalizeMapContext(input?.mapContext);
    if (!mapContext.writable) throw mapImageError(403, "MAP_IMAGE_READ_ONLY", "只读地图不能提交生图任务");
    if (!isRecord(input?.request)) {
      throw mapImageError(400, "MAP_IMAGE_REQUEST_INVALID", "地图生图参数必须是对象");
    }
    const canonicalRequest = canonicalValue(input.request);
    mapAssetQualityTarget(canonicalRequest);
    const request = mapImageJobRequest(canonicalRequest);
    const executionContext = input?.executionContext == null
      ? null
      : canonicalValue(input.executionContext);
    const createdAt = this.now();
    const job = {
      id: crypto.randomBytes(18).toString("base64url"),
      identity,
      mapContext,
      request,
      requestHash: sha256(JSON.stringify(request)),
      executionContext,
      status: "queued",
      phase: "queued",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      candidateDirectory: null,
      candidate: null,
      result: null,
      error: null,
      signal,
      abortListener: null,
      settled: false,
      resolve: null,
      reject: null,
      publishRecord: null,
      publishPromise: null,
      pendingDestinationHash: null,
      onFinalized: typeof input?.onFinalized === "function" ? input.onFinalized : null,
      finalizerCalled: false,
    };
    const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.abortListener = () => this.cancel({ jobId: job.id, identity });
    signal?.addEventListener("abort", job.abortListener, { once: true });
    this.jobs.push(job);
    this.emitChange();
    this.kick();
    return { id: job.id, job: publicJob(job), promise };
  }

  snapshot(input) {
    this.prune();
    return publicJob(this.requireJob(input?.jobId, normalizeIdentity(input?.identity)));
  }

  list(input = {}) {
    this.prune();
    const identity = normalizeIdentity(input.identity);
    const limit = boundedInteger(input.limit, 100, 1, 500);
    const mapSessionId = input.mapSessionId == null ? null : String(input.mapSessionId);
    return this.jobs
      .filter((job) => sameIdentity(job.identity, identity))
      .filter((job) => mapSessionId == null || job.mapContext.mapSessionId === mapSessionId)
      .slice(-limit)
      .reverse()
      .map(publicJob);
  }

  async cancelForMapSession({ identity, mapSessionId } = {}) {
    const normalizedIdentity = normalizeIdentity(identity);
    const sessionId = String(mapSessionId || "");
    const jobs = this.jobs.filter((job) => (
      sameIdentity(job.identity, normalizedIdentity)
      && job.mapContext.mapSessionId === sessionId
      && ACTIVE.has(job.status)
    ));
    for (const job of jobs) {
      await this.cancel({ jobId: job.id, identity: normalizedIdentity });
    }
    return { canceled: jobs.length };
  }

  async cancelForBrowserSession({ userId, browserSessionId } = {}) {
    const browser = normalizeBrowserIdentity({ userId, browserSessionId });
    const jobs = this.jobs.filter((job) => (
      sameBrowser(job.identity, browser) && ACTIVE.has(job.status)
    ));
    for (const job of jobs) await this.cancel({ jobId: job.id, identity: job.identity });
    return Object.freeze({ canceled: jobs.length });
  }

  async cancelForUser({ userId } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    const jobs = this.jobs.filter((job) => (
      job.identity.userId === normalizedUserId && ACTIVE.has(job.status)
    ));
    for (const job of jobs) await this.cancel({ jobId: job.id, identity: job.identity });
    return Object.freeze({ canceled: jobs.length });
  }

  /** Open a staged candidate without exposing its absolute temporary path. */
  async openCandidateFile(input) {
    this.prune();
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    if (!["succeeded", "published", "publishing"].includes(job.status) || !job.candidate) {
      throw mapImageError(409, "MAP_IMAGE_CANDIDATE_UNAVAILABLE", "地图生图候选结果尚未就绪");
    }
    if (String(input?.mapVersion || "") !== job.mapContext.version) {
      throw mapImageError(409, "MAP_IMAGE_VERSION_CONFLICT", "地图版本已变化，请重新生成候选图");
    }
    await this.authorizeSession({
      purpose: "preview",
      identity,
      mapContext: job.mapContext,
      mapVersion: job.mapContext.version,
    });
    const index = Number(input?.index);
    const file = Number.isSafeInteger(index) ? job.candidate.files[index] : null;
    if (!file) throw mapImageError(404, "MAP_IMAGE_CANDIDATE_FILE_NOT_FOUND", "候选图片不存在");
    const handle = await fs.open(file.stagedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.size) {
        throw mapImageError(409, "MAP_IMAGE_CANDIDATE_CHANGED", "候选图片暂存内容已变化");
      }
      const result = { handle, metadata: publicFile(file) };
      // The staged path is an internal bridge for server-owned resource
      // candidate registration only.  It is deliberately non-enumerable so
      // snapshots, HTTP responses, and MCP values can never expose it.
      Object.defineProperty(result, "sourcePath", { value: file.stagedPath, enumerable: false, writable: false });
      return result;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Return server-only metadata for bridging a finished image candidate into
   * the managed resource-candidate store. The absolute staged path is hidden
   * as a non-enumerable property and is never part of a public job snapshot.
   */
  async openCandidateSource(input) {
    this.prune();
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    if (!["succeeded", "published", "publishing"].includes(job.status) || !job.candidate) {
      throw mapImageError(409, "MAP_IMAGE_CANDIDATE_UNAVAILABLE", "地图生图候选结果尚未就绪");
    }
    if (String(input?.mapVersion || "") !== job.mapContext.version) {
      throw mapImageError(409, "MAP_IMAGE_VERSION_CONFLICT", "地图版本已变化，请重新生成候选图");
    }
    await this.authorizeSession({ purpose: "preview", identity, mapContext: job.mapContext, mapVersion: job.mapContext.version });
    const index = Number(input?.index);
    const file = Number.isSafeInteger(index) ? job.candidate.files[index] : null;
    if (!file) throw mapImageError(404, "MAP_IMAGE_CANDIDATE_FILE_NOT_FOUND", "候选图片不存在");
    const stat = await fs.lstat(file.stagedPath);
    if (!stat.isFile() || stat.size !== file.size) throw mapImageError(409, "MAP_IMAGE_CANDIDATE_CHANGED", "候选图片暂存内容已变化");
    const result = { metadata: publicFile(file) };
    Object.defineProperty(result, "sourcePath", { value: file.stagedPath, enumerable: false, writable: false });
    return Object.freeze(result);
  }

  async cancel(input) {
    const job = this.requireJob(input?.jobId, normalizeIdentity(input?.identity));
    if (FINAL.has(job.status)) return { accepted: false, job: publicJob(job) };
    if (job.publishPromise) throw mapImageError(409, "MAP_IMAGE_PUBLISH_IN_PROGRESS", "候选图正在发布，不能同时取消");
    const now = this.now();
    if (job.status === "running") this.running.get(job.id)?.controller.abort();
    job.status = "canceled";
    job.phase = "canceled";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = { code: "MAP_IMAGE_CANCELED", message: "用户取消了地图生图任务" };
    this.settle(job, new MapImageJobError(499, job.error.code, job.error.message));
    // A queued task has not entered the Worker yet, so its input/resource lease
    // can be released immediately. Running tasks keep the lease until the
    // runner's finally block has stopped staging/reading its input.
    if (job.status === "canceled" && !this.running.has(job.id)) await this.runFinalizer(job);
    this.emitChange();
    this.kick();
    return { accepted: true, job: publicJob(job) };
  }

  /** Publish a staged candidate only after an explicit confirmation token. */
  async publish(input) {
    this.prune();
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    if (!["succeeded", "published", "publishing"].includes(job.status) || !job.candidate) {
      throw mapImageError(409, "MAP_IMAGE_CANDIDATE_UNAVAILABLE", "地图生图候选结果尚未就绪");
    }
    if (String(input?.confirmation || "") !== job.id) {
      throw mapImageError(400, "MAP_IMAGE_CONFIRMATION_REQUIRED", "必须显式确认后才能发布地图素材");
    }
    const requestedVersion = String(input?.mapVersion || "");
    if (requestedVersion !== job.mapContext.version) {
      throw mapImageError(409, "MAP_IMAGE_VERSION_CONFLICT", "地图版本已变化，请重新生成候选图");
    }
    assertCandidatePublishable(job);
    const destinations = normalizeDestinations(input?.destinations, job.candidate.files.length);
    for (const destination of destinations) {
      const source = job.candidate.files[destination.index];
      const extension = path.extname(destination.path).slice(1).toLowerCase();
      const allowed = source.format === "jpeg" ? new Set(["jpg", "jpeg"]) : new Set([source.format]);
      if (!allowed.has(extension)) {
        throw mapImageError(400, "MAP_IMAGE_DESTINATION_FORMAT", `发布路径扩展名与候选图格式不匹配: ${destination.path}`);
      }
    }
    const companions = buildMapImagePublicationCompanions({
      companions: input?.companions,
      destinations,
      candidateFiles: job.candidate.files,
      jobId: job.id,
    });
    const publicCompanions = companions.map(({ data, ...entry }) => entry);
    const destinationHash = sha256(JSON.stringify({ destinations, companions: publicCompanions }));
    if (job.publishRecord) {
      if (job.publishRecord.destinationHash !== destinationHash) {
        throw mapImageError(409, "MAP_IMAGE_ALREADY_PUBLISHED", "候选图已发布到其他位置");
      }
      return { job: publicJob(job), published: job.publishRecord.files };
    }
    if (job.publishPromise) {
      if (job.pendingDestinationHash !== destinationHash) {
        throw mapImageError(409, "MAP_IMAGE_PUBLISH_IN_PROGRESS", "候选图正在发布到其他位置");
      }
      return job.publishPromise;
    }
    job.pendingDestinationHash = destinationHash;
    job.status = "publishing";
    job.phase = "committing";
    job.updatedAt = this.now();
    job.publishPromise = (async () => {
      const authorization = await this.authorizeSession({
        purpose: "publish",
        jobId: job.id,
        identity,
        mapContext: job.mapContext,
        mapVersion: requestedVersion,
        candidateBytes: job.candidate.files.reduce((total, file) => total + file.size, 0)
          + companions.reduce((total, file) => total + file.size, 0),
      });
      try {
        return await this.publishCandidateBatch(
          job,
          destinations,
          companions,
          destinationHash,
          authorization,
        );
      } finally {
        await Promise.resolve(authorization?.release?.()).catch(() => {});
      }
    })();
    try {
      return await job.publishPromise;
    } finally {
      job.publishPromise = null;
      job.pendingDestinationHash = null;
      if (!job.publishRecord && job.status === "publishing") {
        job.status = "succeeded";
        job.phase = "succeeded";
        job.updatedAt = this.now();
      }
    }
  }

  async publishCandidateBatch(job, destinations, companions, destinationHash, authorization = null) {
    let projectAnchor = null;
    const releasePublication = beginMapAssetPublication(job.candidateDirectory);
    const journalPath = mapAssetTransactionJournalPath(job.candidateDirectory);
    try {
      projectAnchor = await openImageProjectAnchor(job.mapContext.projectPath);
      const artifacts = [
        ...destinations.map((destination) => {
          const source = job.candidate.files[destination.index];
          return {
            artifactType: "image",
            index: destination.index,
            relativePath: destination.path,
            format: source.format,
            mediaType: source.mediaType,
            width: source.width,
            height: source.height,
            size: source.size,
            sha256: source.sha256,
            sourcePath: source.stagedPath,
          };
        }),
        ...companions,
      ];
      const results = await publishFileBatch({
        outputs: artifacts.map((artifact) => ({
          ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : { data: artifact.data }),
          targetPath: path.join(job.mapContext.projectPath, ...artifact.relativePath.split("/")),
          expected: { size: artifact.size, sha256: artifact.sha256 },
          mode: 0o640,
          uid: Number.isInteger(authorization?.uid) ? authorization.uid : null,
          gid: Number.isInteger(authorization?.gid) ? authorization.gid : null,
        })),
        maxBytesPerFile: this.maxCandidateBytes,
        maxTotalBytes: this.maxCandidateTotalBytes,
      }, {
        projectAnchor,
        journal: (transactionState) => writeMapAssetTransactionJournal({
          journalPath,
          projectPath: job.mapContext.projectPath,
          jobId: job.id,
          state: transactionState,
        }),
      });
      const published = results.map((result, index) => {
        const { data, sourcePath, ...artifact } = artifacts[index];
        return {
          ...artifact,
          size: result.size,
          sha256: result.sha256,
        };
      });
      job.publishRecord = { destinationHash, files: published, publishedAt: this.now() };
      job.publishRecord.provenance = publicProvenance(job);
      job.status = "published";
      job.phase = "published";
      job.updatedAt = this.now();
      this.emitChange();
      await removeMapAssetTransactionJournal(journalPath).catch(() => {});
      return { job: publicJob(job), published };
    } catch (error) {
      if (!error?.rollbackFailures?.length && !error?.partialOutputs?.length) {
        await removeMapAssetTransactionJournal(journalPath).catch(() => {});
      }
      if (error?.code === "IMAGE_OUTPUT_EXISTS") {
        throw mapImageError(409, "MAP_IMAGE_DESTINATION_EXISTS", "地图素材发布目标已存在");
      }
      if (["ELOOP", "ENOTDIR", "IMAGE_PROJECT_SYMLINK"].includes(error?.code)) {
        throw mapImageError(403, "MAP_IMAGE_UNSAFE_DESTINATION", "地图素材发布路径包含符号链接或非目录节点");
      }
      if (error instanceof MapImageJobError) throw error;
      const normalized = mapImageError(
        Number.isInteger(error?.statusCode) ? error.statusCode : 500,
        error?.code || "MAP_IMAGE_PUBLISH_FAILED",
        `地图素材发布失败: ${error.message}`,
      );
      if (error?.rollback) normalized.rollback = structuredClone(error.rollback);
      throw normalized;
    } finally {
      releasePublication();
      await projectAnchor?.close().catch(() => {});
    }
  }

  discard(input) {
    const job = this.requireJob(input?.jobId, normalizeIdentity(input?.identity));
    if (job.publishPromise) {
      throw mapImageError(409, "MAP_IMAGE_PUBLISH_IN_PROGRESS", "候选图正在发布，不能同时丢弃");
    }
    if (!job.candidateDirectory) return { discarded: false, job: publicJob(job) };
    const candidateDirectory = job.candidateDirectory;
    job.status = "expired";
    job.phase = "expired";
    job.updatedAt = this.now();
    job.candidateDirectory = null;
    job.candidate = null;
    void fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
    // Explicit candidate disposal is a terminal transition. Release any
    // temporary source/mask leases retained for this job immediately.
    void this.runFinalizer(job);
    this.emitChange();
    return { discarded: true, job: publicJob(job) };
  }

  status() {
    return {
      queueLength: this.jobs.filter((job) => job.status === "queued").length,
      running: this.running.size,
      candidates: this.jobs.filter((job) => job.status === "succeeded" && job.candidate).length,
    };
  }

  /** Candidate directories currently owned by an in-process publication.
   * Recovery must not inspect or remove these journals while the publisher is
   * still able to make progress.
   */
  protectedPublicationDirectories(projectPath = null) {
    const requested = projectPath == null ? null : path.resolve(String(projectPath));
    return Object.freeze(this.jobs
      .filter((job) => job.publishPromise && job.candidateDirectory)
      .filter((job) => requested == null || path.resolve(job.mapContext.projectPath) === requested)
      .map((job) => job.candidateDirectory));
  }

  async close() {
    this.closed = true;
    const active = this.jobs.filter((job) => ACTIVE.has(job.status));
    await Promise.allSettled(active.map((job) => this.cancel({ jobId: job.id, identity: job.identity })));
    const completions = [...this.running.values()]
      .map((entry) => entry.completion)
      .filter((completion) => completion && typeof completion.then === "function");
    await Promise.allSettled(completions);
  }

  kick() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    queueMicrotask(async () => {
      try {
        while (!this.closed && this.running.size < this.currentLimits().concurrency) {
          const job = this.jobs.find((entry) => entry.status === "queued");
          if (!job) break;
          this.launch(job);
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  launch(job) {
    const controller = new AbortController();
    job.status = "running";
    job.phase = "queued";
    job.startedAt = this.now();
    job.updatedAt = job.startedAt;
    this.running.set(job.id, { controller, job });
    this.emitChange();
    const completion = (async () => {
      try {
        await this.authorizeSession({
          purpose: "execute",
          identity: job.identity,
          mapContext: job.mapContext,
          mapVersion: job.mapContext.version,
        });
        if (controller.signal.aborted) {
          throw mapImageError(499, "MAP_IMAGE_CANCELED", "地图生图任务已取消");
        }
        const result = await this.runner(internalJob(job), {
          signal: controller.signal,
          onEvent: (event) => this.handleRunnerEvent(job, event),
        });
        try {
          if (controller.signal.aborted) throw mapImageError(499, "MAP_IMAGE_CANCELED", "地图生图任务已取消");
          job.candidate = await this.stageCandidate(job, result);
          job.result = publicRunnerResult(job, result);
          job.status = "succeeded";
          job.phase = "succeeded";
          this.settle(job, null, job.result);
        } finally {
          if (typeof result?.dispose === "function") await Promise.resolve(result.dispose()).catch(() => {});
        }
      } catch (error) {
        job.status = controller.signal.aborted ? "canceled" : "failed";
        job.phase = job.status;
        job.error = publicMapImageFailure(error, { canceled: controller.signal.aborted });
        this.settle(job, error);
      } finally {
        job.completedAt = this.now();
        job.updatedAt = job.completedAt;
        this.running.delete(job.id);
        await this.runFinalizer(job);
        this.emitChange();
        this.kick();
      }
    })();
    const running = this.running.get(job.id);
    if (running) running.completion = completion;
  }

  handleRunnerEvent(job, event) {
    if (
      job.status !== "running"
      || !event
      || event.type !== "phase"
      || !["queued", "preparing", "provider", "postprocessing", "committing"].includes(event.phase)
    ) return;
    job.phase = event.phase;
    job.updatedAt = this.now();
    this.emitChange();
  }

  currentLimits() {
    if (!this.limits) return { maxJobs: this.maxJobs, concurrency: this.concurrency };
    const current = this.limits();
    return {
      maxJobs: positiveInteger(current?.maxJobs, this.maxJobs, "limits.maxJobs"),
      concurrency: positiveInteger(current?.concurrency, this.concurrency, "limits.concurrency"),
    };
  }

  async stageCandidate(job, result) {
    const files = Array.isArray(result?.files) ? result.files : [];
    if (!files.length) throw mapImageError(502, "MAP_IMAGE_EMPTY_RESULT", "图片供应商没有返回候选图");
    if (files.length > this.maxCandidateFiles) {
      throw mapImageError(413, "MAP_IMAGE_TOO_MANY_FILES", "候选图数量超过地图任务上限");
    }
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, `candidate-${job.id}-`));
    job.candidateDirectory = directory;
    const staged = [];
    let totalBytes = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const input = files[index];
        let bytes;
        if (input?.sourcePath) {
          let sourceHandle;
          try {
            sourceHandle = await fs.open(String(input.sourcePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
            const sourceStat = await sourceHandle.stat();
            if (!sourceStat.isFile() || sourceStat.size > this.maxCandidateBytes) {
              throw mapImageError(502, "MAP_IMAGE_INVALID_RESULT", "候选图文件类型或大小无效");
            }
            bytes = await sourceHandle.readFile();
          } finally {
            await sourceHandle?.close().catch(() => {});
          }
        }
        else if (Buffer.isBuffer(input?.data)) bytes = input.data;
        else if (input?.data instanceof Uint8Array) bytes = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
        else throw mapImageError(502, "MAP_IMAGE_INVALID_RESULT", "候选图内容无效");
        let inspected;
        try {
          inspected = inspectImageBuffer(bytes, { maxBytes: this.maxCandidateBytes });
        } catch (error) {
          throw mapImageError(502, "MAP_IMAGE_INVALID_RESULT", `候选图不是有效图片: ${error.message}`);
        }
        totalBytes += bytes.length;
        if (totalBytes > this.maxCandidateTotalBytes) {
          throw mapImageError(413, "MAP_IMAGE_CANDIDATE_TOO_LARGE", "候选图总大小超过地图任务上限");
        }
        for (const [field, actual] of Object.entries(inspected)) {
          if (input?.[field] !== undefined && String(input[field]) !== String(actual)) {
            throw mapImageError(502, "MAP_IMAGE_METADATA_MISMATCH", `候选图 ${field} 元数据不匹配`);
          }
        }
        const quality = await inspectMapAssetQuality(bytes, inspected, job.request);
        if (quality && quality.publishable !== true) {
          const alphaFailed = quality.checks.alpha?.passed === false;
          const error = mapImageError(
            422,
            alphaFailed ? "MAP_IMAGE_ALPHA_QUALITY_FAILED" : "MAP_IMAGE_SEAM_QUALITY_FAILED",
            alphaFailed
              ? quality.checks.alpha?.mode === "opaque"
                ? "候选图未通过不透明素材检查：无缝地块或完整背景不能包含透明像素"
                : "候选图未通过透明素材检查：必须包含可见内容和足够的真实透明背景"
              : "候选图未通过周期铺设边缘检查，不能发布为无缝地形",
          );
          error.quality = quality;
          throw error;
        }
        const destination = path.join(directory, `${index}.${inspected.format}`);
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        staged.push({
          index,
          stagedPath: destination,
          name: safeName(input.name, `${index}.png`),
          mediaType: inspected.mediaType,
          format: inspected.format,
          width: inspected.width,
          height: inspected.height,
          size: bytes.length,
          sha256: sha256(bytes),
          quality,
        });
      }
      return { files: staged };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  requireJob(jobId, identity) {
    const job = this.jobs.find((entry) => entry.id === String(jobId || ""));
    if (!job || !sameIdentity(job.identity, identity)) throw mapImageError(404, "MAP_IMAGE_JOB_NOT_FOUND", "地图生图任务不存在");
    return job;
  }

  settle(job, error = null, result = null) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener("abort", job.abortListener);
    if (error) job.reject(error); else job.resolve(result);
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const job of this.jobs) {
      // A canceled running job remains in FINAL while its Worker unwinds. Do
      // not release its inputs until launch()'s finally block has stopped it.
      if (!FINAL.has(job.status) || job.updatedAt > cutoff || this.running.has(job.id)) continue;
      if (job.candidateDirectory) {
        const candidateDirectory = job.candidateDirectory;
        job.candidateDirectory = null;
        job.candidate = null;
        if (job.status === "succeeded") {
          job.status = "expired";
          job.phase = "expired";
        }
        void fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
        void this.runFinalizer(job);
      }
    }
    const { maxJobs } = this.currentLimits();
    if (this.jobs.length > maxJobs * 2) this.jobs = this.jobs.slice(-maxJobs);
  }

  emitChange() { this.emit("change", this.status()); }

  async runFinalizer(job) {
    if (job.finalizerCalled || typeof job.onFinalized !== "function") return;
    job.finalizerCalled = true;
    const finalizer = job.onFinalized;
    job.onFinalized = null;
    await Promise.resolve(finalizer(publicJob(job))).catch(() => {});
  }
}

export class MapImageJobError extends Error {
  constructor(statusCode, code, message) { super(message); this.name = "MapImageJobError"; this.statusCode = statusCode; this.code = code; }
}

function publicJob(job) {
  return {
    id: job.id,
    requestHash: job.requestHash,
    status: job.status,
    phase: job.phase || job.status,
    mapSessionId: job.mapContext.mapSessionId,
    mapVersion: job.mapContext.version,
    request: structuredClone(job.request),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    candidate: job.candidate ? {
      candidateId: job.id,
      files: job.candidate.files.map(publicFile),
    } : null,
    result: job.result ? structuredClone(job.result) : null,
    error: job.error ? { ...job.error } : null,
    selectionTarget: publicSelectionTarget(job.executionContext?.selectionTarget),
    published: job.publishRecord ? structuredClone(job.publishRecord.files) : [],
    publication: job.publishRecord ? structuredClone(job.publishRecord) : null,
  };
}

function publicSelectionTarget(value) {
  if (!isRecord(value)) return null;
  const source = value.target?.schema === "wfl.map-selection-image-target.v1"
    ? {
        ...value.target,
        policies: {
          ...(isRecord(value.target.policies) ? value.target.policies : {}),
          ...(isRecord(value.policies) ? value.policies : {}),
        },
      }
    : value.schema === "wfl.map-selection-image-target.v1"
      ? value
      : null;
  if (!source) return null;
  const rect = (source) => isRecord(source) ? {
    ...(typeof source.space === "string" ? { space: source.space } : {}),
    x: Number(source.x),
    y: Number(source.y),
    width: Number(source.width),
    height: Number(source.height),
  } : null;
  const point = (source) => isRecord(source)
    ? { x: Number(source.x), y: Number(source.y) }
    : null;
  const sides = (source) => isRecord(source) ? {
    top: Number(source.top),
    right: Number(source.right),
    bottom: Number(source.bottom),
    left: Number(source.left),
  } : null;
  return {
    schema: "wfl.map-selection-image-target.v1",
    purpose: String(source.purpose || ""),
    map: {
      version: String(source.map?.version || ""),
      editorStateId: Number(source.map?.editorStateId),
      orientation: String(source.map?.orientation || ""),
      infinite: source.map?.infinite === true,
      tileSize: {
        width: Number(source.map?.tileSize?.width),
        height: Number(source.map?.tileSize?.height),
      },
    },
    layer: {
      id: Number(source.layer?.id),
      type: String(source.layer?.type || ""),
      name: String(source.layer?.name || ""),
      path: Array.isArray(source.layer?.path) ? source.layer.path.map(Number) : [],
    },
    selection: {
      tile: rect(source.selection?.tile),
      mapTile: rect(source.selection?.mapTile),
      world: rect(source.selection?.world),
    },
    expansion: {
      unit: String(source.expansion?.unit || ""),
      tile: source.expansion?.tile == null ? null : sides(source.expansion.tile),
      world: source.expansion?.world == null ? null : sides(source.expansion.world),
    },
    target: {
      tile: source.target?.tile == null ? null : rect(source.target.tile),
      mapTile: source.target?.mapTile == null ? null : rect(source.target.mapTile),
      world: rect(source.target?.world),
      sourceOffset: point(source.target?.sourceOffset),
    },
    policies: {
      maskMode: String(source.policies?.maskMode || ""),
      preserveSource: String(source.policies?.preserveSource || ""),
      ...(typeof source.policies?.alignmentPolicy === "string"
        ? { alignmentPolicy: source.policies.alignmentPolicy }
        : {}),
      ...(Number.isSafeInteger(source.policies?.blendMargin)
        ? { blendMargin: source.policies.blendMargin }
        : {}),
    },
    logicalCanvas: {
      width: Number(source.logicalCanvas?.width),
      height: Number(source.logicalCanvas?.height),
    },
  };
}

function publicFile(file) {
  return {
    index: file.index,
    name: file.name,
    mediaType: file.mediaType,
    format: file.format,
    width: file.width,
    height: file.height,
    size: file.size,
    sha256: file.sha256,
    ...(file.quality ? { quality: structuredClone(file.quality) } : {}),
  };
}

async function inspectMapAssetQuality(bytes, inspected, request) {
  const target = mapAssetQualityTarget(request);
  if (!target) return null;
  const decoded = await sharp(bytes, {
    animated: false,
    failOn: "warning",
    limitInputPixels: inspected.width * inspected.height,
  }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== inspected.width
    || decoded.info.height !== inspected.height
    || decoded.info.channels !== 4
    || decoded.data.length !== inspected.width * inspected.height * 4
  ) {
    throw mapImageError(502, "MAP_IMAGE_INVALID_RESULT", "候选图 RGBA 像素解码结果不完整");
  }

  const totalPixels = inspected.width * inspected.height;
  let transparentPixels = 0;
  let fullyTransparentPixels = 0;
  let visiblePixels = 0;
  let borderPixels = 0;
  let borderFullyTransparentPixels = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4 + 3;
    const alpha = decoded.data[offset];
    if (alpha < 255) transparentPixels += 1;
    if (alpha === 0) fullyTransparentPixels += 1;
    if (alpha > 0) visiblePixels += 1;
    const x = pixel % inspected.width;
    const y = Math.floor(pixel / inspected.width);
    if (x === 0 || y === 0 || x === inspected.width - 1 || y === inspected.height - 1) {
      borderPixels += 1;
      if (alpha === 0) borderFullyTransparentPixels += 1;
    }
  }
  const borderTransparentCoverage = roundQualityMetric(
    borderPixels ? borderFullyTransparentPixels / borderPixels : 0,
  );
  const transparentModePassed = inspected.format === "png"
    && fullyTransparentPixels > 0
    && visiblePixels > 0
    && (!target.propBorderTransparency
      || borderTransparentCoverage >= MIN_PROP_BORDER_TRANSPARENT_COVERAGE);
  const opaqueModePassed = inspected.format === "png"
    && transparentPixels === 0
    && visiblePixels === totalPixels;
  const alpha = {
    required: true,
    mode: target.alphaMode,
    format: inspected.format,
    totalPixels,
    transparentPixels,
    fullyTransparentPixels,
    visiblePixels,
    borderPixels,
    borderFullyTransparentPixels,
    borderTransparentCoverage,
    minimumBorderTransparentCoverage: target.propBorderTransparency
      ? MIN_PROP_BORDER_TRANSPARENT_COVERAGE
      : 0,
    passed: target.alphaMode === "opaque" ? opaqueModePassed : transparentModePassed,
  };
  const tiling = target.periodic
    ? inspectPeriodicEdges(decoded.data, inspected.width, inspected.height)
    : null;
  const publishable = alpha.passed && (!tiling || tiling.passed);
  return {
    schemaVersion: MAP_ASSET_QUALITY_REPORT_SCHEMA,
    targetSchemaVersion: MAP_ASSET_QUALITY_SCHEMA,
    assetKind: target.assetKind,
    publishable,
    checks: {
      alpha,
      ...(tiling ? { tiling } : {}),
    },
  };
}

function inspectPeriodicEdges(pixels, width, height) {
  const horizontal = comparePeriodicEdge(pixels, width, height, "horizontal");
  const vertical = comparePeriodicEdge(pixels, width, height, "vertical");
  return {
    required: true,
    mode: "periodic",
    axes: ["horizontal", "vertical"],
    thresholds: {
      maximumMeanAbsoluteError: MAX_EDGE_MEAN_ABSOLUTE_ERROR,
      minimumVisibleCoverage: MIN_EDGE_VISIBLE_COVERAGE,
      visibleAlphaThreshold: VISIBLE_ALPHA_THRESHOLD,
    },
    horizontal,
    vertical,
    passed: horizontal.passed && vertical.passed,
  };
}

function comparePeriodicEdge(pixels, width, height, axis) {
  const samplePairs = axis === "horizontal" ? height : width;
  const edgePair = axis === "horizontal" ? "left-right" : "top-bottom";
  if (width < 2 || height < 2 || samplePairs < 1) {
    return {
      edgePair,
      samplePairs,
      meanAbsoluteError: 255,
      maximumAbsoluteError: 255,
      visibleCoverage: 0,
      passed: false,
    };
  }
  let absoluteDifference = 0;
  let maximumAbsoluteError = 0;
  let visiblePairs = 0;
  for (let sample = 0; sample < samplePairs; sample += 1) {
    const firstPixel = axis === "horizontal"
      ? sample * width
      : sample;
    const secondPixel = axis === "horizontal"
      ? sample * width + width - 1
      : (height - 1) * width + sample;
    const firstOffset = firstPixel * 4;
    const secondOffset = secondPixel * 4;
    const firstAlpha = pixels[firstOffset + 3];
    const secondAlpha = pixels[secondOffset + 3];
    if (Math.max(firstAlpha, secondAlpha) >= VISIBLE_ALPHA_THRESHOLD) visiblePairs += 1;
    for (let channel = 0; channel < 4; channel += 1) {
      const first = channel === 3
        ? firstAlpha
        : Math.round(pixels[firstOffset + channel] * firstAlpha / 255);
      const second = channel === 3
        ? secondAlpha
        : Math.round(pixels[secondOffset + channel] * secondAlpha / 255);
      const difference = Math.abs(first - second);
      absoluteDifference += difference;
      maximumAbsoluteError = Math.max(maximumAbsoluteError, difference);
    }
  }
  const meanAbsoluteError = roundQualityMetric(absoluteDifference / (samplePairs * 4));
  const visibleCoverage = roundQualityMetric(visiblePairs / samplePairs);
  return {
    edgePair,
    samplePairs,
    meanAbsoluteError,
    maximumAbsoluteError,
    visibleCoverage,
    passed: meanAbsoluteError <= MAX_EDGE_MEAN_ABSOLUTE_ERROR
      && visibleCoverage >= MIN_EDGE_VISIBLE_COVERAGE,
  };
}

function mapAssetQualityTarget(request) {
  const operation = String(request?.operation || "generate");
  const hasAssetKind = Object.hasOwn(request || {}, "assetKind");
  const hasQualityTarget = Object.hasOwn(request || {}, "qualityTarget");
  if (!hasAssetKind && !hasQualityTarget) return null;
  if (operation !== "generate") {
    throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "只有生成操作可以声明地图素材质量目标");
  }
  const assetKind = String(request?.assetKind || "");
  const qualityTarget = request?.qualityTarget;
  if (!MAP_ASSET_KINDS.has(assetKind) || !isRecord(qualityTarget)) {
    throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "地图素材质量目标类型无效");
  }
  if (qualityTarget.schemaVersion !== MAP_ASSET_QUALITY_SCHEMA) {
    throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "地图素材质量目标版本无效");
  }
  if (TRANSPARENT_MAP_ASSET_KINDS.has(assetKind)) {
    if (!hasExactKeys(qualityTarget, ["alpha", "schemaVersion"]) || qualityTarget.alpha !== "required") {
      throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "透明地图素材质量目标无效");
    }
    return {
      assetKind,
      alphaMode: "transparent",
      propBorderTransparency: assetKind === "plant" || assetKind === "prop",
      periodic: false,
    };
  }
  if (assetKind === "background") {
    if (!hasExactKeys(qualityTarget, ["alpha", "schemaVersion"]) || qualityTarget.alpha !== "opaque") {
      throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "完整背景必须声明固定的不透明质量目标");
    }
    return {
      assetKind,
      alphaMode: "opaque",
      propBorderTransparency: false,
      periodic: false,
    };
  }
  if (
    !hasExactKeys(qualityTarget, ["schemaVersion", "tiling"])
    || !isRecord(qualityTarget.tiling)
    || !hasExactKeys(qualityTarget.tiling, ["axes", "mode"])
    || qualityTarget.tiling.mode !== "periodic"
    || !Array.isArray(qualityTarget.tiling.axes)
    || qualityTarget.tiling.axes.length !== 2
    || qualityTarget.tiling.axes[0] !== "horizontal"
    || qualityTarget.tiling.axes[1] !== "vertical"
  ) {
    throw mapImageError(400, "MAP_IMAGE_QUALITY_TARGET_INVALID", "无缝地形必须声明固定的横纵双轴周期质量目标");
  }
  return {
    assetKind: "terrain",
    alphaMode: "opaque",
    propBorderTransparency: false,
    periodic: true,
  };
}

function assertCandidatePublishable(job) {
  const target = mapAssetQualityTarget(job.request);
  if (!target) return;
  const verified = job.candidate?.files?.every((file) => (
    file.quality?.schemaVersion === MAP_ASSET_QUALITY_REPORT_SCHEMA
    && file.quality?.assetKind === target.assetKind
    && file.quality?.publishable === true
  ));
  if (!verified) {
    throw mapImageError(
      409,
      "MAP_IMAGE_QUALITY_UNVERIFIED",
      "候选图缺少通过的像素质量报告，不能发布",
    );
  }
}

function roundQualityMetric(value) {
  return Math.round(value * 10_000) / 10_000;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function publicRunnerResult(job, result) {
  const operation = ["crop", "generate", "edit", "outpaint"].includes(result?.requested?.operation)
    ? result.requested.operation
    : ["crop", "generate", "edit", "outpaint"].includes(job.request?.operation)
      ? job.request.operation
      : null;
  const usage = sanitizeUsage(result?.usage);
  const requested = sanitizeRequested(result?.requested);
  return {
    candidateId: job.id,
    requestHash: job.requestHash,
    provider: operation === "crop" ? "wfl-local" : "wfl",
    operation,
    sourceConsumed: operation ? operation !== "generate" : false,
    inputImageTokens: Number.isSafeInteger(usage?.inputImageTokens) ? usage.inputImageTokens : 0,
    usage,
    providerRequestId: safeIdentifier(result?.providerRequestId, 200),
    requested,
  };
}

function publicProvenance(job) {
  const requested = job.result?.requested || {};
  return {
    requestHash: job.requestHash,
    provider: job.result?.provider || "wfl",
    operation: job.result?.operation || null,
    model: typeof requested.model === "string" ? requested.model : null,
    providerProfileRevision: safeRevision(requested.providerProfileRevision),
    configurationRevision: safeRevision(requested.configurationRevision),
    providerRequestId: safeIdentifier(job.result?.providerRequestId, 200),
  };
}

function sanitizeUsage(value) {
  if (!isRecord(value)) return null;
  const output = {};
  for (const key of [
    "inputTokens", "inputTextTokens", "inputImageTokens", "cachedInputTokens",
    "outputTokens", "reasoningOutputTokens", "totalTokens",
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  return Object.keys(output).length ? output : null;
}

function sanitizeRequested(value) {
  if (!isRecord(value)) return null;
  const output = {};
  if (["crop", "generate", "edit", "outpaint"].includes(value.operation)) output.operation = value.operation;
  if (typeof value.model === "string" && value.model.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value.model)) {
    output.model = value.model;
  }
  if (Number.isSafeInteger(value.n) && value.n >= 1 && value.n <= 10) output.n = value.n;
  for (const key of ["size", "providerSize", "sourceSize", "requestedCanvas"]) {
    if (value[key] == null && key === "sourceSize") {
      output[key] = null;
    } else if (/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(String(value[key] || ""))) {
      output[key] = String(value[key]);
    }
  }
  for (const key of ["quality", "outputFormat", "background", "moderation", "maskMode", "preserveSource", "alignmentPolicy"]) {
    const text = safeIdentifier(value[key], 100);
    if (text) output[key] = text;
  }
  for (const key of ["outputCompression", "partialImages", "maskFeather", "blendMargin"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  if (typeof value.stream === "boolean") output.stream = value.stream;
  if (typeof value.sourceConsumed === "boolean") output.sourceConsumed = value.sourceConsumed;
  for (const key of ["providerProfileRevision", "configurationRevision"]) {
    const revision = safeRevision(value[key]);
    if (revision) output[key] = revision;
  }
  if (Array.isArray(value.postprocess)) {
    output.postprocess = value.postprocess
      .filter((entry) => typeof entry === "string" && /^[A-Za-z0-9:,.>_-]{1,200}$/u.test(entry))
      .slice(0, 32);
  }
  return Object.keys(output).length ? output : null;
}

function safeIdentifier(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)
    ? text
    : null;
}

function safeRevision(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{32,64}$/u.test(text) ? text : null;
}

function internalJob(job) {
  return {
    id: job.id,
    identity: structuredClone(job.identity),
    mapContext: structuredClone(job.mapContext),
    request: structuredClone(job.request),
    executionContext: job.executionContext == null ? null : structuredClone(job.executionContext),
    candidateDirectory: job.candidateDirectory,
  };
}

function mapImageJobRequest(value) {
  const request = {};
  for (const key of MAP_IMAGE_REQUEST_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === "outpaint" || key === "expand" || key === "sourceCrop") {
      const expansion = value[key];
      request[key] = isRecord(expansion)
        ? Object.fromEntries(["top", "right", "bottom", "left"]
          .filter((side) => Object.hasOwn(expansion, side))
          .map((side) => [side, expansion[side]]))
        : expansion;
      continue;
    }
    if (key === "sourceSize") {
      request[key] = isRecord(value[key])
        ? Object.fromEntries(["width", "height"]
          .filter((dimension) => Object.hasOwn(value[key], dimension))
          .map((dimension) => [dimension, value[key][dimension]]))
        : value[key];
      continue;
    }
    request[key] = value[key];
  }
  return request;
}

function publicMapImageFailure(error, { canceled = false } = {}) {
  if (canceled) {
    return { code: "MAP_IMAGE_CANCELED", message: "用户取消了地图生图任务" };
  }
  const rawCode = String(error?.code || "MAP_IMAGE_FAILED").slice(0, 100);
  const code = /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(rawCode) ? rawCode : "MAP_IMAGE_FAILED";
  let message = String(error?.message || "地图生图失败").trim().slice(0, 1_000);
  message = message
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/giu, "[已隐藏地址]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/gu, "[已隐藏路径]")
    .replace(/(^|[\s("'])\/[^\s"'<>]+/gu, "$1[已隐藏路径]")
    .replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 [已隐藏]")
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|secret|token)\b\s*[:=]\s*[^\s,;]+/giu, "$1=[已隐藏]")
    .trim();
  const result = { code, message: message || "地图生图失败" };
  // Keep the map-editor job contract useful for diagnosis without exposing
  // provider payloads, filesystem paths, or credentials. The image worker
  // already attaches these fields to structured failures; dropping them here
  // made an otherwise actionable 502 look identical to every other failure.
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    result.statusCode = error.statusCode;
  }
  if (typeof error?.retryable === "boolean") result.retryable = error.retryable;
  for (const field of ["stage", "operation", "reason"]) {
    const value = safeFailureIdentifier(error?.[field], 100);
    if (value) result[field] = value;
  }
  const model = safeFailureText(error?.model, 200);
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) result.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const value = safeFailureText(error?.[field], 32);
    if (value && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value)) result[field] = value;
  }
  const providerRequestId = safeFailureIdentifier(error?.providerRequestId ?? error?.requestId, 200);
  if (providerRequestId) result.providerRequestId = providerRequestId;
  if (Number.isInteger(error?.providerStatusCode) && error.providerStatusCode >= 400 && error.providerStatusCode <= 599) {
    result.providerStatusCode = error.providerStatusCode;
  }
  for (const field of ["requestedWidth", "requestedHeight", "actualWidth", "actualHeight"]) {
    if (Number.isSafeInteger(error?.[field]) && error[field] >= 1 && error[field] <= 100_000) {
      result[field] = error[field];
    }
  }
  if (Array.isArray(error?.supportedSizes)) {
    const supportedSizes = [...new Set(error.supportedSizes
      .map((value) => safeFailureText(value, 32))
      .filter((value) => /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value || "")))]
      .slice(0, 64);
    if (supportedSizes.length) result.supportedSizes = supportedSizes;
  }
  if (["strict", "soft"].includes(error?.maskMode)) result.maskMode = error.maskMode;
  if (["exact", "seamless"].includes(error?.preserveSource)) result.preserveSource = error.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(error?.alignmentPolicy)) {
    result.alignmentPolicy = error.alignmentPolicy;
  }
  if (isRecord(error?.quality) && error.quality.schemaVersion === MAP_ASSET_QUALITY_REPORT_SCHEMA) {
    result.quality = structuredClone(error.quality);
  }
  return result;
}

function safeFailureText(value, maximum) {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim()
    : null;
}

function safeFailureIdentifier(value, maximum) {
  const text = safeFailureText(value, maximum);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || !browserSessionId) throw mapImageError(400, "MAP_IMAGE_IDENTITY_INVALID", "地图生图身份无效");
  return Object.freeze({ userId, browserSessionId, editorInstanceId: String(value?.editorInstanceId || "") });
}
function normalizeBrowserIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || !browserSessionId) throw mapImageError(400, "MAP_IMAGE_IDENTITY_INVALID", "地图生图身份无效");
  return Object.freeze({ userId, browserSessionId });
}
function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId) throw mapImageError(400, "MAP_IMAGE_IDENTITY_INVALID", "地图生图身份无效");
  return userId;
}
function sameBrowser(a, b) { return a.userId === b.userId && a.browserSessionId === b.browserSessionId; }
function sameIdentity(a, b) { return a.userId === b.userId && a.browserSessionId === b.browserSessionId && a.editorInstanceId === b.editorInstanceId; }
function normalizeMapContext(value) {
  const mapSessionId = String(value?.mapSessionId || value?.sessionId || "");
  const version = String(value?.version || "");
  const rawProjectPath = String(value?.projectPath || "");
  const projectPath = path.resolve(rawProjectPath || ".");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(mapSessionId)) throw mapImageError(400, "MAP_IMAGE_MAP_SESSION_INVALID", "地图会话标识无效");
  if (!/^[a-f0-9]{64}$/u.test(version)) throw mapImageError(400, "MAP_IMAGE_MAP_VERSION_INVALID", "地图版本无效");
  if (!path.isAbsolute(rawProjectPath) || projectPath === path.parse(projectPath).root) throw mapImageError(400, "MAP_IMAGE_PROJECT_INVALID", "地图工程路径无效");
  const targetPath = value?.targetPath ? path.resolve(String(value.targetPath)) : null;
  if (targetPath && !isPathWithin(projectPath, targetPath)) {
    throw mapImageError(400, "MAP_IMAGE_TARGET_INVALID", "地图文件必须位于当前工程内");
  }
  return Object.freeze({ mapSessionId, version, projectPath, targetPath, writable: value?.writable === true });
}
function normalizeDestinations(value, count) {
  if (!Array.isArray(value) || value.length !== count) throw mapImageError(400, "MAP_IMAGE_DESTINATIONS_INVALID", "必须为每张候选图指定发布路径");
  const indexes = new Set();
  const paths = new Set();
  return value.map((entry, index) => {
    const i = Number.isSafeInteger(entry?.index) ? entry.index : index;
    if (i < 0 || i >= count || indexes.has(i)) throw mapImageError(400, "MAP_IMAGE_DESTINATION_INDEX_INVALID", "候选图编号无效或重复");
    const target = String(entry?.path || "").replaceAll("\\", "/");
    const segments = target.split("/");
    if (
      !target
      || target.startsWith("/")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || segments.some((segment) => RESERVED_PROJECT_SEGMENTS.has(segment))
      || /[\u0000-\u001f\u007f:*?"<>|]/u.test(target)
      || paths.has(target)
    ) throw mapImageError(400, "MAP_IMAGE_DESTINATION_INVALID", "发布路径必须是安全且唯一的工程内相对路径");
    if (entry?.overwrite === true) {
      throw mapImageError(400, "MAP_IMAGE_OVERWRITE_UNSUPPORTED", "地图素材不能静默覆盖现有文件");
    }
    indexes.add(i);
    paths.add(target);
    return { index: i, path: target };
  });
}
function canonicalValue(value, depth = 0) {
  if (depth > 20) throw mapImageError(400, "MAP_IMAGE_REQUEST_TOO_DEEP", "地图生图参数嵌套过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 100_000 || value.includes("\u0000")) {
      throw mapImageError(400, "MAP_IMAGE_REQUEST_TEXT_INVALID", "地图生图文本参数无效");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw mapImageError(400, "MAP_IMAGE_REQUEST_NUMBER_INVALID", "地图生图数字参数无效");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw mapImageError(400, "MAP_IMAGE_REQUEST_ARRAY_TOO_LARGE", "地图生图参数数组过大");
    return value.map((entry) => canonicalValue(entry, depth + 1));
  }
  if (!isRecord(value)) throw mapImageError(400, "MAP_IMAGE_REQUEST_VALUE_INVALID", "地图生图参数值无效");
  const keys = Object.keys(value).sort();
  if (keys.length > 1_000) throw mapImageError(400, "MAP_IMAGE_REQUEST_FIELDS_TOO_LARGE", "地图生图参数字段过多");
  return Object.fromEntries(keys.map((key) => {
    if (!key || key.length > 100 || key.includes("\u0000")) {
      throw mapImageError(400, "MAP_IMAGE_REQUEST_FIELD_INVALID", "地图生图参数字段名无效");
    }
    return [key, canonicalValue(value[key], depth + 1)];
  }));
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeName(value, fallback) { const name = path.basename(String(value || fallback)); return name && name !== "." ? name : fallback; }
function isPathWithin(root, candidate) { const relative = path.relative(root, candidate); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function boundedInteger(value, fallback, min, max) { const n = Number(value); return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback; }
function positiveInteger(value, fallback, name) { if (value === undefined) return fallback; const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive integer`); return n; }
function mapImageError(statusCode, code, message) { return new MapImageJobError(statusCode, code, message); }
