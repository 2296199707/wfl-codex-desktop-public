import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { agentMessageDisplayText } from "../public/conversation-state.js";
import { subagentActivityStatus } from "../public/thread-state.js";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function uiFunction(name, globals = {}) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))?.[0];
  assert.ok(declaration, `missing ${name}`);
  return vm.runInNewContext(`(${declaration})`, globals);
}

test("0.153 question messages and function outputs use the existing transcript renderers", () => {
  const render = uiFunction("renderItem", {
    agentMessageDisplayText,
    messageTimestamp: () => null,
    transcriptExpansionKey: () => "item-key",
    protocolEntityId: (value) => value?.id,
    turnStatusType: (value) => value?.status,
    codexMessageBranchPoint: () => null,
    renderMessage: (role, text) => ({ role, text }),
    safeProtocolJson: JSON.stringify,
    renderCollapsibleTool: (icon, title, output, status) => ({ icon, title, output, status }),
  });
  const turn = { id: "turn-1", status: "inProgress" };
  assert.deepEqual(render({
    type: "agentMessage", id: "question", text: "",
    questions: [{ title: "Which environment?", options: ["Development", "Production"] }],
  }, turn), {
    role: "agent", text: "Which environment?\n\n1. Development\n\n2. Production",
  });
  const output = render({
    type: "functionCallOutput", id: "tool-result", namespace: "functions", name: "lookup", output: "ready",
  }, turn);
  assert.equal(output.title, "functions / lookup");
  assert.equal(output.output, "ready");
  assert.equal(output.status, "completed");
  assert.equal(render({ type: "agentMessage", text: "", questions: null }, turn), null);
});

test("0.153 subagent completion and stdin review are displayed without changing the parent turn", () => {
  const status = uiFunction("mapConversationActivityStatus", {
    subagentActivityStatus,
    turnStatusType: (value) => value?.status,
  });
  const turn = { status: "inProgress" };
  assert.equal(status({ type: "subAgentActivity", kind: "completed" }, turn), "completed");
  assert.equal(status({ type: "subAgentActivity", kind: "interrupted" }, turn), "stopped");
  assert.equal(status({ type: "subAgentActivity", kind: "started" }, { status: "completed" }), "completed");
  assert.equal(status({ type: "subAgentActivity", kind: "interacted" }, { status: "failed" }), "failed");
  assert.equal(turn.status, "inProgress");
  const summary = uiFunction("guardianActionSummary");
  assert.match(summary({ type: "writeStdin", processId: "123", cwd: "/srv/project", stdin: "status\n" }), /123[\s\S]*\/srv\/project[\s\S]*status/);
  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.match(source, new RegExp(`${tool}: "[^"\\n]+"`));
  }
});
