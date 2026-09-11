import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { readCodexThreadHistory } from "../lib/codex-thread-history.mjs";
import { TurnStartDeduplicator } from "../lib/turn-start-deduplicator.mjs";

const source = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const start = source.indexOf("class CodexBridge extends EventEmitter");
const bridgeSource = source.slice(start, source.indexOf("\n}\n", start) + 2);

function fakeBridge(handler, { rescue = false } = {}) {
  const Bridge = vm.runInNewContext(`(${bridgeSource})`, {
    EventEmitter, readCodexThreadHistory, RESCUE_MODE: rescue,
    DEFAULT_PROJECT: "/tmp", setTimeout, clearTimeout,
  });
  const bridge = new Bridge();
  const requests = [];
  bridge.child = { stdin: { writable: true, write(line) {
    const request = JSON.parse(line);
    requests.push(request);
    queueMicrotask(() => {
      try {
        const result = handler(request.method, request.params, bridge);
        bridge.handleMessage(JSON.stringify({ id: request.id, result }));
      } catch (error) {
        bridge.handleMessage(JSON.stringify({ id: request.id, error: { code: -32602, message: error.message } }));
      }
    });
  } } };
  return { bridge, requests };
}

test("main bridge reads all paginated history without deprecation and preserves retry deduplication", async () => {
  const turns = [
    { id: "t1", status: "completed", items: [{ type: "commandExecution", id: "tool1", aggregatedOutput: "kept" }] },
    { id: "t2", status: "inProgress", items: [{ type: "userMessage", id: "u2", clientId: "retry-id", content: [] }] },
  ];
  const notifications = [];
  const { bridge, requests } = fakeBridge((method, params, bridge) => {
    if (method === "thread/read") {
      if (params.includeTurns) bridge.emit("notification", {method:"deprecationNotice"});
      return { thread: { id: "thread1", historyMode: "paginated", status: {type:"active"}, turns: [] } };
    }
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "full");
    assert.equal(params.sortDirection, "asc");
    assert.equal(params.threadId, "thread1");
    return params.cursor === null ? {data:[turns[0]], nextCursor:"page2"} : {data:[turns[1]], nextCursor:null};
  });
  bridge.on("notification", (notification) => notifications.push(notification));
  const observed = [];
  const result = await bridge.request("thread/read", {threadId:"thread1",includeTurns:true}, {
    onResponseObserved: message => observed.push(message),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.thread.turns)), turns);
  assert.equal(result.thread.status.type, "active");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].id, requests[0].id);
  assert.strictEqual(observed[0].result, result);
  const dedup = new TurnStartDeduplicator((...args) => bridge.request(...args));
  const retry = await dedup.run({threadId:"thread1",clientUserMessageId:"retry-id"}, () => {
    assert.fail("A user message on the second page must prevent duplicate submission");
  });
  assert.equal(retry.turn.id, "t2");
  assert.equal(notifications.length, 0);
  assert.equal(requests.some(r => r.method === "thread/read" && r.params.includeTurns), false);
});

test("legacy reads keep their original full response and metadata-only reads do not paginate", async () => {
  const {bridge,requests} = fakeBridge((method,params) => {
    assert.equal(method,"thread/read");
    return {thread:{id:"legacy",turns:params.includeTurns ? [{id:"old",items:[]}] : []}};
  });
  assert.equal((await bridge.request("thread/read",{threadId:"legacy",includeTurns:true})).thread.turns[0].id,"old");
  await bridge.request("thread/read",{threadId:"legacy",includeTurns:false});
  assert.deepEqual(requests.map(r=>r.params.includeTurns),[false,true,false]);
});

test("full snapshot failures never turn into empty history or a replayed submission", async () => {
  for (const badPage of [
    {data:[{id:"turn",itemsView:"summary",items:[]}],nextCursor:null},
    {data:[{id:"turn"}],nextCursor:null},
    {nextCursor:null},
    {data:[],nextCursor:"repeat"},
  ]) {
    let calls = 0;
    const request = (method) => {
      calls++;
      assert(calls <= 3, "repeated cursors must terminate");
      return method === "thread/read" ? {thread:{historyMode:"paginated"}} : badPage;
    };
    const dedup = new TurnStartDeduplicator((method,params) => readCodexThreadHistory(request,params));
    await assert.rejects(dedup.run({threadId:"t",clientUserMessageId:"unknown"},()=>assert.fail("must not replay")),
      {code:"ERR_CODEX_HISTORY_PAGE"});
  }
});

test("pagination shares the caller deadline instead of restarting its timeout on every page", async () => {
  let now = 0;
  const budgets = [];
  await assert.rejects(readCodexThreadHistory(async (method,params,options) => {
    budgets.push(options.timeoutMs);
    if (method === "thread/read") { now = 25; return {thread:{historyMode:"paginated"}}; }
    now = 100;
    return {data:[],nextCursor:"more"};
  },{threadId:"t",includeTurns:true},{timeoutMs:100},{now:()=>now}),{code:"ERR_CODEX_RPC_TIMEOUT"});
  assert.deepEqual(budgets,[100,75]);
});

test("native page errors keep rejection details and are observed once", async () => {
  const observed = [];
  const {bridge} = fakeBridge(method => {
    if (method === "thread/read") return {thread:{historyMode:"paginated"}};
    throw new Error("history store unavailable");
  });
  await assert.rejects(bridge.request("thread/read",{threadId:"t",includeTurns:true},{onResponseObserved:m=>observed.push(m)}),
    error => error.code === "ERR_CODEX_RPC_REJECTED" && error.codexError.message === "history store unavailable");
  assert.equal(observed.length,1);
  assert.equal(observed[0].error.message,"history store unavailable");
});

test("a restart or fence between pages prevents reading from a different runtime", async () => {
  for (const change of ["restart","fence"]) {
    const {bridge,requests} = fakeBridge((method,params,bridge) => {
      assert.equal(method,"thread/read");
      if (change === "restart") bridge.child = {stdin:{writable:true}};
      else bridge.beginRequestFence("provider switching");
      return {thread:{historyMode:"paginated"}};
    });
    await assert.rejects(bridge.request("thread/read",{threadId:"t",includeTurns:true}),
      {code:change === "restart" ? "ERR_CODEX_RPC_DISCONNECTED" : "ERR_CODEX_BRIDGE_FENCED"});
    assert.equal(requests.length,1);
  }
});

test("rescue reads retain the frozen raw request path", async () => {
  const {bridge,requests} = fakeBridge((method,params) => ({thread:{id:params.threadId,turns:[]}}),{rescue:true});
  await bridge.request("thread/read",{threadId:"rescue",includeTurns:true});
  assert.equal(requests.length,1);
  assert.equal(requests[0].params.includeTurns,true);
});
