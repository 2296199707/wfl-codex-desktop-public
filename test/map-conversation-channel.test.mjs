import assert from "node:assert/strict";
import test from "node:test";

import {
  createMapConversationRequest,
  createMapConversationResult,
  createMapConversationSnapshot,
  parseMapConversationRequest,
  parseMapConversationResult,
  parseMapConversationSnapshot,
} from "../public/map-editor/map-conversation-channel.js";

const binding = Object.freeze({
  hostWindowId: "host-window-1234",
  editorInstanceId: "editor-window-1234",
  sessionId: "map-session-1234",
  projectPath: "/srv/project",
});

test("map conversation requests are bound and reject cross-window messages", () => {
  const request = createMapConversationRequest("send", {
    ...binding,
    requestId: "request-id-1234",
    operationId: "operation-id-1234",
    threadId: "thread-id-1234",
    text: "请调整森林入口",
  }, 100);
  assert.equal(parseMapConversationRequest(request, binding)?.text, "请调整森林入口");
  assert.equal(parseMapConversationRequest(request, { ...binding, sessionId: "other-session" }), null);
  assert.equal(parseMapConversationRequest({ ...request, text: "" }, binding), null);

  const hydrate = createMapConversationRequest("hydrate-thread", {
    ...binding,
    requestId: "request-id-3456",
    threadId: "thread-id-1234",
  }, 100);
  assert.equal(parseMapConversationRequest(hydrate, binding)?.threadId, "thread-id-1234");

  const interrupt = createMapConversationRequest("interrupt", {
    ...binding,
    requestId: "request-id-5678",
    threadId: "thread-id-1234",
    turnId: "turn-id-1234",
  }, 100);
  assert.equal(parseMapConversationRequest(interrupt, binding)?.turnId, "turn-id-1234");
  assert.throws(() => createMapConversationRequest("interrupt", {
    ...binding,
    requestId: "request-id-6789",
    threadId: "thread-id-1234",
  }, 100), /Invalid turnId/u);

  const unbind = createMapConversationRequest("unbind-thread", {
    ...binding,
    requestId: "request-id-7890",
    expectedBoundThreadId: "thread-id-1234",
  }, 100);
  assert.equal(parseMapConversationRequest(unbind, binding)?.action, "unbind-thread");
  assert.equal(unbind.expectedBoundThreadId, "thread-id-1234");
});

test("map conversation snapshots contain only bounded display projections", () => {
  const snapshot = createMapConversationSnapshot({
    ...binding,
    requestId: "request-id-1234",
    revision: 7,
    contextVersion: 11,
    eventSequence: 19,
    runtime: "codex",
    boundThreadId: "thread-id-1234",
    activeThreadId: "thread-id-1234",
    threads: [{
      id: "thread-id-1234",
      title: "森林关卡",
      preview: "继续调整出生点",
      updatedAt: 90,
      status: "running",
      model: "gpt-5",
      provider: "WFL",
    }],
    messages: [{
      id: "message-id-1234",
      turnId: "turn-id-1234",
      role: "user",
      text: "看一下入口",
      attachments: [{ kind: "image", name: "forest.png" }],
      createdAt: 91,
    }],
    conversation: {
      status: "running",
      label: "Codex 正在处理",
      canSend: true,
      canInterrupt: true,
      activeTurnId: "turn-id-1234",
      imageIsolationEnabled: true,
    },
    threadState: {
      status: "running",
      activeTurnId: "turn-id-1234",
      loaded: true,
      complete: false,
      earlierAvailable: true,
      updatedAt: 93,
    },
    compaction: {
      status: "completed",
      count: 2,
      lastAt: 94,
      updatedAt: 94,
      label: "已记录 2 次上下文压缩",
    },
    activities: [{
      id: "activity-id-1234",
      type: "mcp",
      status: "completed",
      title: "MCP 工具",
      turnId: "turn-id-1234",
      updatedAt: 95,
    }],
    loading: {
      status: "partial",
      complete: false,
      label: "已显示缓存内容，历史仍在加载",
      updatedAt: 96,
    },
    imageDelivery: {
      mode: "reference",
      referenceCount: 1,
      label: "1 张重复图片仅发送元数据引用",
      updatedAt: 92,
    },
  }, 100);
  const parsed = parseMapConversationSnapshot(snapshot, binding);
  assert.equal(parsed.threads[0].status, "running");
  assert.deepEqual(parsed.messages[0].attachments, [{ kind: "image", name: "forest.png" }]);
  assert.equal(parsed.imageDelivery.mode, "reference");
  assert.equal(parsed.contextVersion, 11);
  assert.equal(parsed.eventSequence, 19);
  assert.equal(parsed.threadState.complete, false);
  assert.equal(parsed.threadState.earlierAvailable, true);
  assert.equal(parsed.compaction.count, 2);
  assert.equal(parsed.activities[0].type, "mcp");
  assert.equal(parsed.loading.status, "partial");
  assert.equal(Object.isFrozen(parsed.messages), true);
  assert.equal(parseMapConversationSnapshot({ ...snapshot, messages: new Array(81).fill(snapshot.messages[0]) }, binding), null);
});

test("map conversation results preserve request identity without carrying payloads", () => {
  const result = createMapConversationResult({
    ...binding,
    requestId: "request-id-1234",
    action: "switch-thread",
    ok: true,
    message: "已切换",
    threadId: "thread-id-5678",
  }, 100);
  assert.equal(parseMapConversationResult(result, binding)?.threadId, "thread-id-5678");
  assert.equal(parseMapConversationResult({ ...result, projectPath: "/srv/other" }, binding), null);
});
