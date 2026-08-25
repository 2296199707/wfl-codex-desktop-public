import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const TURN_COUNT = 80;
const RECENT_TURNS = 8;
const DIFF_LINES = 20_000;
const DIFF_PAGE_LINES = 500;
const DOM_SLICE_LINES = 10;
const TEXT_SLICE_CHARACTERS = 8 * 1024;
const TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const REASONING_BYTES = 512 * 1024;
const MAIN_THREAD_SLICE_BUDGET_MS = 8;
const MAX_MOUNTED_DOM_NODES = 5_000;

let browser = null;
let context = null;
let temporaryRoot = null;

try {
  temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wfl-on-demand-render-"),
  );
  await fs.chmod(temporaryRoot, 0o700);
  browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent(`
    <!doctype html>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
      #stage {
        height: 620px;
        overflow: auto;
        overflow-anchor: none;
        padding: 12px;
      }
      #list { display: grid; gap: 8px; overflow-anchor: none; }
      .older-placeholder { background: #f4f4f5; border-radius: 8px; }
      .turn { border: 1px solid #ddd; border-radius: 10px; padding: 8px; }
      .turn-items { display: grid; gap: 6px; }
      .item { border: 1px solid #e5e7eb; border-radius: 8px; }
      .message { padding: 8px; white-space: pre-wrap; }
      details > summary { cursor: pointer; padding: 8px; }
      .details-body { padding: 0 8px 8px; }
      .diff-line { white-space: pre; font-family: monospace; }
      .load-more { margin-top: 8px; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
    <main id="stage"><section id="list"></section></main>
  `);

  await page.evaluate((configuration) => {
    const {
      turnCount,
      recentTurns,
      diffLineCount,
      diffPageLines,
      domSliceLines,
      textSliceCharacters,
      toolOutputBytes,
      reasoningBytes,
    } = configuration;
    const stage = document.getElementById("stage");
    const list = document.getElementById("list");
    const bodyStore = new Map();
    const bodyReads = new Map();
    const foldState = new Map();
    const itemNodes = new Map();
    const parsedDiffs = new Set();
    const viewState = new Map();
    const workerRequests = new Map();
    let workerRequestId = 0;
    let fullRenderCount = 0;
    const domSlices = [];
    const diffDomSlices = [];
    const textPreviewSlices = [];
    const streamPatchSlices = [];
    const longTasks = [];
    const workerUrl = URL.createObjectURL(new Blob([`
      const parsed = new Map();
      self.onmessage = (event) => {
        const data = event.data || {};
        try {
          if (data.op === "parse") {
            const startedAt = performance.now();
            const lines = String(data.raw || "").split("\\n");
            const parseMs = performance.now() - startedAt;
            parsed.set(data.bodyRef, lines);
            self.postMessage({
              requestId: data.requestId,
              ok: true,
              parseMs,
              totalLines: lines.length,
              lines: lines.slice(0, data.limit),
            });
            return;
          }
          if (data.op === "page") {
            const lines = parsed.get(data.bodyRef);
            if (!lines) throw new Error("diff-not-parsed");
            self.postMessage({
              requestId: data.requestId,
              ok: true,
              parseMs: 0,
              totalLines: lines.length,
              lines: lines.slice(data.offset, data.offset + data.limit),
            });
            return;
          }
          throw new Error("unknown-worker-operation");
        } catch (error) {
          self.postMessage({
            requestId: data.requestId,
            ok: false,
            error: error.message,
          });
        }
      };
    `], { type: "text/javascript" }));
    const diffWorker = new Worker(workerUrl);
    diffWorker.addEventListener("message", (event) => {
      const pending = workerRequests.get(event.data?.requestId);
      if (!pending) return;
      workerRequests.delete(event.data.requestId);
      if (event.data.ok) pending.resolve(event.data);
      else pending.reject(new Error(event.data.error || "worker-failed"));
    });
    try {
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Long Task timing is optional in some Chromium builds.
    }

    const diffBodyRef = "body:diff";
    const toolBodyRef = "body:tool";
    const reasoningBodyRef = "body:reasoning";
    const diffRaw = Array.from({ length: diffLineCount }, (_, index) => {
      const prefix = index % 3 === 0 ? "+" : index % 3 === 1 ? "-" : " ";
      return `${prefix}${String(index + 1).padStart(5, "0")} synthetic diff line`;
    }).join("\n");
    bodyStore.set(diffBodyRef, diffRaw);
    bodyStore.set(
      toolBodyRef,
      `TOOL_OUTPUT_START\n${"t".repeat(toolOutputBytes)}\nTOOL_OUTPUT_END`,
    );
    bodyStore.set(
      reasoningBodyRef,
      `REASONING_START\n${"r".repeat(reasoningBytes)}\nREASONING_END`,
    );

    const turns = Array.from({ length: turnCount }, (_, index) => ({
      canonicalId: `turn:${String(index + 1).padStart(4, "0")}`,
      revision: 1,
      items: [{
        canonicalId: `item:message:${String(index + 1).padStart(4, "0")}`,
        aliases: new Set([`live:msg_${index + 1}`]),
        type: "agentMessage",
        revision: 1,
        text: `assistant message ${index + 1}`,
      }],
    }));
    const specialTurn = turns.at(-3);
    const streamItem = specialTurn.items[0];
    const fileItem = {
      canonicalId: "item:file-change:stable",
      aliases: new Set(["live:msg_file_change"]),
      type: "fileChange",
      revision: 1,
      bodyRef: diffBodyRef,
      summary: {
        files: 1,
        additions: Math.ceil(diffLineCount / 3),
        deletions: Math.floor(diffLineCount / 3),
        lines: diffLineCount,
        bytes: diffRaw.length,
      },
    };
    const toolItem = {
      canonicalId: "item:command:stable",
      aliases: new Set(["live:msg_command"]),
      type: "commandExecution",
      revision: 1,
      bodyRef: toolBodyRef,
      summary: {
        title: "synthetic command",
        bytes: bodyStore.get(toolBodyRef).length,
      },
    };
    const reasoningItem = {
      canonicalId: "item:reasoning:stable",
      aliases: new Set(["live:msg_reasoning"]),
      type: "reasoning",
      revision: 1,
      bodyRef: reasoningBodyRef,
      summary: {
        title: "synthetic reasoning",
        bytes: bodyStore.get(reasoningBodyRef).length,
      },
    };
    specialTurn.items.push(fileItem, toolItem, reasoningItem);
    const unreadItemKey = itemKey(specialTurn, streamItem);

    function itemKey(turn, item) {
      return `${turn.canonicalId}\0${item.canonicalId}`;
    }

    function readBody(bodyRef) {
      bodyReads.set(bodyRef, (bodyReads.get(bodyRef) || 0) + 1);
      return bodyStore.get(bodyRef);
    }

    function bodyReadCount(bodyRef) {
      return bodyReads.get(bodyRef) || 0;
    }

    function workerRequest(message) {
      const requestId = ++workerRequestId;
      return new Promise((resolve, reject) => {
        workerRequests.set(requestId, { resolve, reject });
        diffWorker.postMessage({ ...message, requestId });
      });
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    function captureScrollAnchor() {
      const stageTop = stage.getBoundingClientRect().top;
      for (const node of list.children) {
        if (!node.dataset.key || node.classList.contains("older-placeholder")) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom < stageTop) continue;
        return {
          key: node.dataset.key,
          offset: rect.top - stageTop,
          scrollTop: stage.scrollTop,
        };
      }
      return { key: null, offset: 0, scrollTop: stage.scrollTop };
    }

    function restoreScrollAnchor(anchor) {
      if (!anchor?.key) {
        stage.scrollTop = anchor?.scrollTop || 0;
        return;
      }
      const node = [...list.children].find(
        (candidate) => candidate.dataset.key === anchor.key,
      );
      if (!node) {
        stage.scrollTop = anchor.scrollTop;
        return;
      }
      const stageTop = stage.getBoundingClientRect().top;
      stage.scrollTop += node.getBoundingClientRect().top
        - stageTop
        - anchor.offset;
    }

    function reconcileChildren(parent, desired) {
      const desiredKeys = new Set(desired.map((entry) => entry.key));
      const existing = new Map(
        [...parent.children]
          .filter((node) => node.dataset.key)
          .map((node) => [node.dataset.key, node]),
      );
      let anchor = parent.firstChild;
      for (const entry of desired) {
        const node = existing.get(entry.key) || entry.create();
        node.dataset.key = entry.key;
        entry.patch(node);
        if (node !== anchor) parent.insertBefore(node, anchor);
        anchor = node.nextSibling;
      }
      for (const node of [...parent.children]) {
        if (!desiredKeys.has(node.dataset.key)) node.remove();
      }
    }

    function createTurnNode() {
      const node = document.createElement("article");
      node.className = "turn";
      const heading = document.createElement("strong");
      heading.className = "turn-heading";
      const items = document.createElement("div");
      items.className = "turn-items";
      node.append(heading, items);
      return node;
    }

    function patchTurnNode(node, turn) {
      node.querySelector(".turn-heading").textContent = turn.canonicalId;
      const items = node.querySelector(".turn-items");
      reconcileChildren(items, turn.items.map((item) => ({
        key: itemKey(turn, item),
        create: () => createItemNode(turn, item),
        patch: (itemNode) => patchItemNode(itemNode, turn, item),
      })));
    }

    function createItemNode(turn, item) {
      const key = itemKey(turn, item);
      let node;
      if (item.type === "agentMessage") {
        node = document.createElement("section");
        node.className = "item message";
        const text = document.createElement("span");
        text.className = "message-text";
        node.append(text);
      } else {
        node = document.createElement("details");
        node.className = `item details-item ${item.type}`;
        const summary = document.createElement("summary");
        const title = document.createElement("strong");
        title.className = "item-title";
        const stats = document.createElement("span");
        stats.className = "item-stats";
        summary.append(title, stats);
        const body = document.createElement("div");
        body.className = "details-body";
        node.append(summary, body);
        node.open = foldState.get(key) === true;
        node.addEventListener("toggle", () => {
          foldState.set(key, node.open);
          if (node.open) void materializeItem(turn, item, node);
          else unmountItemBody(key, node);
        });
      }
      itemNodes.set(key, node);
      return node;
    }

    function patchItemNode(node, turn, item) {
      const key = itemKey(turn, item);
      node.dataset.revision = String(item.revision);
      if (item.type === "agentMessage") {
        const text = node.querySelector(".message-text");
        if (text.textContent !== item.text) text.textContent = item.text;
        return;
      }
      const title = node.querySelector(".item-title");
      const stats = node.querySelector(".item-stats");
      if (item.type === "fileChange") {
        title.textContent = "synthetic/file.txt";
        stats.textContent = `+${item.summary.additions} -${item.summary.deletions}`
          + ` · ${item.summary.lines} lines`;
      } else {
        title.textContent = item.summary.title;
        stats.textContent = `${item.summary.bytes} bytes`;
      }
      itemNodes.set(key, node);
    }

    async function renderTranscript() {
      const anchor = captureScrollAnchor();
      const windowTurns = turns.slice(-recentTurns);
      const hiddenTurns = Math.max(0, turns.length - windowTurns.length);
      const desired = [];
      if (hiddenTurns > 0) {
        desired.push({
          key: "control:older-placeholder",
          create: () => {
            const placeholder = document.createElement("div");
            placeholder.className = "older-placeholder";
            return placeholder;
          },
          patch: (placeholder) => {
            placeholder.style.height = `${hiddenTurns * 120}px`;
            placeholder.dataset.hiddenTurns = String(hiddenTurns);
          },
        });
      }
      for (const turn of windowTurns) {
        desired.push({
          key: turn.canonicalId,
          create: createTurnNode,
          patch: (node) => patchTurnNode(node, turn),
        });
      }
      reconcileChildren(list, desired);
      fullRenderCount += 1;
      await nextFrame();
      restoreScrollAnchor(anchor);
      await nextFrame();
    }

    async function appendDiffLines(container, lines, startIndex) {
      for (let offset = 0; offset < lines.length; offset += domSliceLines) {
        await nextFrame();
        const startedAt = performance.now();
        const fragment = document.createDocumentFragment();
        const slice = lines.slice(offset, offset + domSliceLines);
        slice.forEach((line, index) => {
          const row = document.createElement("div");
          row.className = "diff-line";
          row.dataset.line = String(startIndex + offset + index + 1);
          row.textContent = line;
          fragment.append(row);
        });
        container.append(fragment);
        const elapsed = performance.now() - startedAt;
        domSlices.push(elapsed);
        diffDomSlices.push(elapsed);
      }
    }

    async function materializeDiff(turn, item, node) {
      const key = itemKey(turn, item);
      const body = node.querySelector(".details-body");
      if (body.dataset.materializing === "true" || body.dataset.materialized === "true") {
        return;
      }
      body.dataset.materializing = "true";
      let page;
      if (parsedDiffs.has(item.bodyRef)) {
        page = await workerRequest({
          op: "page",
          bodyRef: item.bodyRef,
          offset: 0,
          limit: diffPageLines,
        });
      } else {
        page = await workerRequest({
          op: "parse",
          bodyRef: item.bodyRef,
          raw: readBody(item.bodyRef),
          limit: diffPageLines,
        });
        parsedDiffs.add(item.bodyRef);
      }
      if (!node.open || foldState.get(key) !== true) {
        body.dataset.materializing = "false";
        return;
      }
      body.replaceChildren();
      const lines = document.createElement("div");
      lines.className = "diff-lines";
      body.append(lines);
      await appendDiffLines(lines, page.lines, 0);
      const loadMore = document.createElement("button");
      loadMore.type = "button";
      loadMore.className = "load-more";
      loadMore.textContent = "load next 500";
      loadMore.addEventListener("click", () => void loadMoreDiff(turn, item, node));
      if (page.lines.length < page.totalLines) body.append(loadMore);
      viewState.set(key, {
        renderedLines: page.lines.length,
        totalLines: page.totalLines,
        workerParseMs: page.parseMs,
      });
      body.dataset.materializing = "false";
      body.dataset.materialized = "true";
    }

    async function loadMoreDiff(turn, item, node) {
      const key = itemKey(turn, item);
      const current = viewState.get(key);
      if (!current || current.renderedLines >= current.totalLines) return;
      const page = await workerRequest({
        op: "page",
        bodyRef: item.bodyRef,
        offset: current.renderedLines,
        limit: diffPageLines,
      });
      const lines = node.querySelector(".diff-lines");
      await appendDiffLines(lines, page.lines, current.renderedLines);
      current.renderedLines += page.lines.length;
      node.querySelector(".load-more")?.remove();
      if (current.renderedLines < current.totalLines) {
        const loadMore = document.createElement("button");
        loadMore.type = "button";
        loadMore.className = "load-more";
        loadMore.textContent = "load next 500";
        loadMore.addEventListener("click", () => void loadMoreDiff(turn, item, node));
        node.querySelector(".details-body").append(loadMore);
      }
    }

    async function materializeText(turn, item, node) {
      const key = itemKey(turn, item);
      const body = node.querySelector(".details-body");
      if (
        body.dataset.materialized === "true"
        || body.dataset.materializing === "true"
      ) {
        return;
      }
      body.dataset.materializing = "true";
      const raw = readBody(item.bodyRef);
      const preview = raw.slice(0, 64 * 1024);
      const pre = document.createElement("pre");
      body.replaceChildren(pre);
      for (
        let offset = 0;
        offset < preview.length;
        offset += textSliceCharacters
      ) {
        await nextFrame();
        const startedAt = performance.now();
        pre.append(document.createTextNode(
          preview.slice(offset, offset + textSliceCharacters),
        ));
        const elapsed = performance.now() - startedAt;
        domSlices.push(elapsed);
        textPreviewSlices.push(elapsed);
      }
      body.dataset.materializing = "false";
      body.dataset.materialized = "true";
      viewState.set(key, {
        previewCharacters: pre.textContent.length,
        totalCharacters: raw.length,
      });
    }

    async function materializeItem(turn, item, node) {
      const key = itemKey(turn, item);
      foldState.set(key, true);
      if (item.type === "fileChange") {
        await materializeDiff(turn, item, node);
      } else {
        await materializeText(turn, item, node);
      }
    }

    function unmountItemBody(key, node) {
      foldState.set(key, false);
      const body = node.querySelector(".details-body");
      body.replaceChildren();
      body.dataset.materialized = "false";
      body.dataset.materializing = "false";
      viewState.delete(key);
    }

    async function setItemOpen(turn, item, open) {
      const key = itemKey(turn, item);
      const node = itemNodes.get(key);
      node.open = open;
      foldState.set(key, open);
      if (open) await materializeItem(turn, item, node);
      else unmountItemBody(key, node);
      await nextFrame();
      return node;
    }

    async function waitForDiffRows(expected) {
      const startedAt = performance.now();
      while (document.querySelectorAll(".diff-line").length !== expected) {
        if (performance.now() - startedAt > 5_000) {
          throw new Error(`timed out waiting for ${expected} diff rows`);
        }
        await nextFrame();
      }
    }

    function mountedDomNodes() {
      return list.querySelectorAll("*").length;
    }

    function mountedAllNodes() {
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_ALL);
      let count = 0;
      while (walker.nextNode()) count += 1;
      return count;
    }

    async function runProbe() {
      const probeStartedAt = performance.now();
      const initialStartedAt = performance.now();
      await renderTranscript();
      const initialRenderMs = performance.now() - initialStartedAt;
      const fileKey = itemKey(specialTurn, fileItem);
      const toolKey = itemKey(specialTurn, toolItem);
      const reasoningKey = itemKey(specialTurn, reasoningItem);
      const closed = {
        mountedTurns: list.querySelectorAll(".turn").length,
        hiddenTurns: Number(
          list.querySelector(".older-placeholder")?.dataset.hiddenTurns || 0,
        ),
        diffRows: list.querySelectorAll(".diff-line").length,
        materializedBodies: list.querySelectorAll(
          ".details-body[data-materialized='true']",
        ).length,
        bodyReads: bodyReadCount(diffBodyRef)
          + bodyReadCount(toolBodyRef)
          + bodyReadCount(reasoningBodyRef),
        domNodes: mountedDomNodes(),
        allNodes: mountedAllNodes(),
      };

      const fileNodeBefore = itemNodes.get(fileKey);
      await setItemOpen(specialTurn, fileItem, true);
      await waitForDiffRows(diffPageLines);
      const firstExpansion = {
        rows: list.querySelectorAll(".diff-line").length,
        bodyReads: bodyReadCount(diffBodyRef),
        workerParseMs: viewState.get(fileKey).workerParseMs,
        domNodes: mountedDomNodes(),
        allNodes: mountedAllNodes(),
      };

      fileItem.aliases.add("snapshot:item-file-change-42");
      fileItem.revision += 1;
      await renderTranscript();
      const fileNodeAfterAlias = itemNodes.get(fileKey);
      const aliasCalibration = {
        sameNode: fileNodeBefore === fileNodeAfterAlias,
        stillOpen: fileNodeAfterAlias.open,
        rowsPreserved: fileNodeAfterAlias.querySelectorAll(".diff-line").length,
        bodyReads: bodyReadCount(diffBodyRef),
      };

      await loadMoreDiff(specialTurn, fileItem, fileNodeAfterAlias);
      await waitForDiffRows(diffPageLines * 2);
      const secondPage = {
        rows: list.querySelectorAll(".diff-line").length,
        bodyReads: bodyReadCount(diffBodyRef),
      };

      await setItemOpen(specialTurn, fileItem, false);
      const afterClose = {
        rows: list.querySelectorAll(".diff-line").length,
        bodyReads: bodyReadCount(diffBodyRef),
        rawBodyRetained: bodyStore.get(diffBodyRef) === diffRaw,
      };
      await setItemOpen(specialTurn, fileItem, true);
      await waitForDiffRows(diffPageLines);
      const afterReopen = {
        rows: list.querySelectorAll(".diff-line").length,
        bodyReads: bodyReadCount(diffBodyRef),
        rawBodyRetained: bodyStore.get(diffBodyRef) === diffRaw,
      };

      const toolNode = await setItemOpen(specialTurn, toolItem, true);
      const toolPreview = {
        previewCharacters: toolNode.querySelector("pre")?.textContent.length || 0,
        bodyReads: bodyReadCount(toolBodyRef),
        rawBodyRetained:
          bodyStore.get(toolBodyRef).length === toolItem.summary.bytes,
      };
      await setItemOpen(specialTurn, toolItem, false);
      const toolAfterClose = {
        previewNodes: toolNode.querySelectorAll("pre").length,
        rawBodyRetained:
          bodyStore.get(toolBodyRef).length === toolItem.summary.bytes,
      };
      const reasoningClosed = {
        bodyReads: bodyReadCount(reasoningBodyRef),
        bodyNodes: itemNodes.get(reasoningKey)
          .querySelector(".details-body").childNodes.length,
        rawBodyRetained:
          bodyStore.get(reasoningBodyRef).length === reasoningItem.summary.bytes,
      };

      const streamNodeBefore = itemNodes.get(unreadItemKey);
      const renderCountBeforeStream = fullRenderCount;
      for (let index = 0; index < 100; index += 1) {
        const startedAt = performance.now();
        streamItem.text += ` delta-${index}`;
        streamItem.revision += 1;
        const target = streamNodeBefore.querySelector(".message-text");
        target.textContent = streamItem.text;
        streamNodeBefore.dataset.revision = String(streamItem.revision);
        streamPatchSlices.push(performance.now() - startedAt);
      }
      const streaming = {
        sameNode: streamNodeBefore === itemNodes.get(unreadItemKey),
        fullRendersAdded: fullRenderCount - renderCountBeforeStream,
        patches: streamPatchSlices.length,
        finalTextVisible:
          streamNodeBefore.querySelector(".message-text").textContent
          === streamItem.text,
      };

      const placeholder = list.querySelector(".older-placeholder");
      stage.scrollTop = placeholder.offsetHeight
        + list.querySelectorAll(".turn")[2].offsetTop
        - list.querySelectorAll(".turn")[0].offsetTop;
      await nextFrame();
      const anchorBefore = captureScrollAnchor();
      const anchorNodeBefore = [...list.children].find(
        (node) => node.dataset.key === anchorBefore.key,
      );
      const anchorTopBefore = anchorNodeBefore.getBoundingClientRect().top;
      const older = Array.from({ length: 16 }, (_, index) => ({
        canonicalId: `turn:older:${String(index + 1).padStart(2, "0")}`,
        revision: 1,
        items: [{
          canonicalId: `item:older:${index + 1}`,
          aliases: new Set([`jsonl:older:${index + 1}`]),
          type: "agentMessage",
          revision: 1,
          text: `older message ${index + 1}`,
        }],
      }));
      turns.unshift(...older);
      await renderTranscript();
      const anchorNodeAfter = [...list.children].find(
        (node) => node.dataset.key === anchorBefore.key,
      );
      const scrollStability = {
        anchorKey: anchorBefore.key,
        sameNode: anchorNodeBefore === anchorNodeAfter,
        topShiftPx: Math.abs(
          anchorNodeAfter.getBoundingClientRect().top - anchorTopBefore,
        ),
        hiddenTurnsAfterPrepend: Number(
          list.querySelector(".older-placeholder").dataset.hiddenTurns,
        ),
      };

      const unreadStability = {
        key: unreadItemKey,
        nodeStillMounted: itemNodes.get(unreadItemKey)?.isConnected === true,
        aliasesDoNotChangeKey:
          itemKey(specialTurn, streamItem) === unreadItemKey,
      };
      await new Promise((resolve) => setTimeout(resolve, 60));
      const relevantLongTasks = longTasks.filter(
        (entry) => entry.startTime >= probeStartedAt,
      );
      const result = {
        closed,
        firstExpansion,
        aliasCalibration,
        secondPage,
        afterClose,
        afterReopen,
        toolPreview,
        toolAfterClose,
        reasoningClosed,
        streaming,
        scrollStability,
        unreadStability,
        performance: {
          initialRenderMs,
          domSlices: domSlices.length,
          maxDomSliceMs: Math.max(0, ...domSlices),
          maxDiffDomSliceMs: Math.max(0, ...diffDomSlices),
          maxTextPreviewSliceMs: Math.max(0, ...textPreviewSlices),
          maxStreamPatchMs: Math.max(0, ...streamPatchSlices),
          longTasks: relevantLongTasks.length,
          maxLongTaskMs: Math.max(
            0,
            ...relevantLongTasks.map((entry) => entry.duration),
          ),
          finalDomNodes: mountedDomNodes(),
          finalAllNodes: mountedAllNodes(),
        },
        lifecycle: {
          fullRenderCount,
          pendingWorkerRequests: workerRequests.size,
        },
      };
      diffWorker.terminate();
      URL.revokeObjectURL(workerUrl);
      return result;
    }

    window.__runOnDemandRenderProbe = runProbe;
  }, {
    turnCount: TURN_COUNT,
    recentTurns: RECENT_TURNS,
    diffLineCount: DIFF_LINES,
    diffPageLines: DIFF_PAGE_LINES,
    domSliceLines: DOM_SLICE_LINES,
    textSliceCharacters: TEXT_SLICE_CHARACTERS,
    toolOutputBytes: TOOL_OUTPUT_BYTES,
    reasoningBytes: REASONING_BYTES,
  });

  const metrics = await page.evaluate(() => window.__runOnDemandRenderProbe());
  assert.deepEqual(pageErrors, []);
  assert.equal(metrics.closed.mountedTurns, RECENT_TURNS);
  assert.equal(metrics.closed.hiddenTurns, TURN_COUNT - RECENT_TURNS);
  assert.equal(metrics.closed.diffRows, 0);
  assert.equal(metrics.closed.materializedBodies, 0);
  assert.equal(metrics.closed.bodyReads, 0);
  assert.ok(metrics.closed.domNodes < MAX_MOUNTED_DOM_NODES);
  assert.ok(metrics.closed.allNodes < MAX_MOUNTED_DOM_NODES);

  assert.equal(metrics.firstExpansion.rows, DIFF_PAGE_LINES);
  assert.equal(metrics.firstExpansion.bodyReads, 1);
  assert.ok(metrics.firstExpansion.domNodes < MAX_MOUNTED_DOM_NODES);
  assert.ok(metrics.firstExpansion.allNodes < MAX_MOUNTED_DOM_NODES);
  assert.equal(metrics.aliasCalibration.sameNode, true);
  assert.equal(metrics.aliasCalibration.stillOpen, true);
  assert.equal(metrics.aliasCalibration.rowsPreserved, DIFF_PAGE_LINES);
  assert.equal(metrics.aliasCalibration.bodyReads, 1);
  assert.equal(metrics.secondPage.rows, DIFF_PAGE_LINES * 2);
  assert.equal(metrics.secondPage.bodyReads, 1);
  assert.equal(metrics.afterClose.rows, 0);
  assert.equal(metrics.afterClose.bodyReads, 1);
  assert.equal(metrics.afterClose.rawBodyRetained, true);
  assert.equal(metrics.afterReopen.rows, DIFF_PAGE_LINES);
  assert.equal(metrics.afterReopen.bodyReads, 1);
  assert.equal(metrics.afterReopen.rawBodyRetained, true);

  assert.equal(metrics.toolPreview.previewCharacters, 64 * 1024);
  assert.equal(metrics.toolPreview.bodyReads, 1);
  assert.equal(metrics.toolPreview.rawBodyRetained, true);
  assert.equal(metrics.toolAfterClose.previewNodes, 0);
  assert.equal(metrics.toolAfterClose.rawBodyRetained, true);
  assert.equal(metrics.reasoningClosed.bodyReads, 0);
  assert.equal(metrics.reasoningClosed.bodyNodes, 0);
  assert.equal(metrics.reasoningClosed.rawBodyRetained, true);

  assert.equal(metrics.streaming.sameNode, true);
  assert.equal(metrics.streaming.fullRendersAdded, 0);
  assert.equal(metrics.streaming.patches, 100);
  assert.equal(metrics.streaming.finalTextVisible, true);
  assert.equal(metrics.scrollStability.sameNode, true);
  assert.ok(metrics.scrollStability.anchorKey);
  assert.ok(metrics.scrollStability.topShiftPx <= 1);
  assert.equal(
    metrics.scrollStability.hiddenTurnsAfterPrepend,
    TURN_COUNT - RECENT_TURNS + 16,
  );
  assert.equal(metrics.unreadStability.nodeStillMounted, true);
  assert.equal(metrics.unreadStability.aliasesDoNotChangeKey, true);

  assert.ok(
    metrics.performance.maxDomSliceMs <= MAIN_THREAD_SLICE_BUDGET_MS,
  );
  assert.ok(
    metrics.performance.maxStreamPatchMs <= MAIN_THREAD_SLICE_BUDGET_MS,
  );
  assert.equal(metrics.performance.longTasks, 0);
  assert.ok(metrics.performance.finalDomNodes < MAX_MOUNTED_DOM_NODES);
  assert.ok(metrics.performance.finalAllNodes < MAX_MOUNTED_DOM_NODES);
  assert.equal(metrics.lifecycle.pendingWorkerRequests, 0);

  console.log(JSON.stringify({
    ok: true,
    fixture: {
      turns: TURN_COUNT,
      recentTurns: RECENT_TURNS,
      diffLines: DIFF_LINES,
      diffPageLines: DIFF_PAGE_LINES,
      domSliceLines: DOM_SLICE_LINES,
      textSliceCharacters: TEXT_SLICE_CHARACTERS,
      toolOutputBytes: TOOL_OUTPUT_BYTES,
      reasoningBytes: REASONING_BYTES,
    },
    ...metrics,
    limits: {
      readsProductionState: false,
      productionRendererImplemented: false,
      currentRendererExecuted: false,
      browserEngine: "headless Chromium",
      mobileHardwareValidated: false,
      candidatePerformanceValidated: false,
      workerCrashRecoveryValidated: false,
      accessibilityValidated: false,
      memoryPressureValidated: false,
    },
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
