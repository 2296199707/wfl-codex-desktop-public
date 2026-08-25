import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThirdPartySubagentContextFromPolicy,
  normalizeStoredThirdPartySubagentContext,
  thirdPartySubagentApprovalPolicy,
  thirdPartySubagentWorkspaceRootsFit,
} from "../lib/third-party-subagent-policy.mjs";

test("maps official approval policies without widening permissions", () => {
  assert.equal(thirdPartySubagentApprovalPolicy("never"), "never");
  assert.equal(thirdPartySubagentApprovalPolicy("ask"), "ask");
  assert.equal(thirdPartySubagentApprovalPolicy("on-request"), "ask");
  assert.equal(thirdPartySubagentApprovalPolicy("untrusted"), "ask");
  assert.equal(thirdPartySubagentApprovalPolicy({ granular: { sandbox_approval: false } }), "ask");
  assert.equal(thirdPartySubagentApprovalPolicy({ unsupported: true }), null);
});

test("workspace-write accepts only the parent cwd as a writable root", () => {
  const cwd = "/srv/projects/demo";
  assert.equal(thirdPartySubagentWorkspaceRootsFit(cwd, [], []), true);
  assert.equal(thirdPartySubagentWorkspaceRootsFit(cwd, [cwd], [cwd]), true);
  assert.equal(thirdPartySubagentWorkspaceRootsFit(cwd, ["/srv/projects/other"], []), false);
  assert.equal(thirdPartySubagentWorkspaceRootsFit(cwd, [], ["/srv/projects/other"]), false);
  assert.equal(thirdPartySubagentWorkspaceRootsFit(cwd, "invalid", []), false);
});

test("rejects a structured workspace policy that grants an extra root", () => {
  const cwd = "/srv/projects/demo";
  const context = codexThirdPartySubagentContextFromPolicy({
    cwd,
    approvalPolicy: "never",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [cwd, "/srv/projects/other"],
    },
  });
  assert.equal(context.unsupported, true);
  assert.equal(context.sandboxMode, null);
  assert.equal(normalizeStoredThirdPartySubagentContext(context), null);
});

test("accepts the official implicit workspace root and keeps private context minimal", () => {
  const cwd = "/srv/projects/demo";
  const context = codexThirdPartySubagentContextFromPolicy({
    cwd,
    approvalPolicy: { granular: { sandbox_approval: false } },
    sandbox: { type: "workspaceWrite", writableRoots: [] },
    runtimeWorkspaceRoots: [cwd],
  });
  assert.deepEqual(context, {
    cwd,
    sandboxMode: "workspace-write",
    approvalPolicy: "ask",
  });
});
