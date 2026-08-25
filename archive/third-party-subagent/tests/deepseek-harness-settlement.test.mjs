import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOfficialSettlementMessage,
  stopReasonFromOfficialSummary,
} from "../lib/deepseek-harness-settlement.mjs";

test("settlement parsing prefers the official source summary and does not depend on block position", () => {
  const parsed = parseOfficialSettlementMessage({
    content: [
      { type: "text", text: "localized presentation summary" },
      { type: "text", text: "Its closing message:" },
      { type: "text", text: "final answer" },
    ],
    source: {
      kind: "subagent-settled",
      form: "notice",
      summary: "Background child finished and will do no further work unless you send it more.",
      senderSessionId: "child-1",
    },
  });
  assert.equal(
    parsed.summary,
    "Background child finished and will do no further work unless you send it more.",
  );
  assert.equal(parsed.finalResponse, "final answer");
  assert.equal(stopReasonFromOfficialSummary(parsed.summary), "completed");
});

test("settlement parsing keeps output when the renderer omits the English marker", () => {
  const parsed = parseOfficialSettlementMessage({
    content: [
      { type: "text", text: "Background child failed before it finished." },
      { type: "text", text: "partial answer" },
    ],
    source: {
      kind: "subagent-settled",
      form: "notice",
      summary: "Background child failed before it finished.",
      senderSessionId: "child-2",
    },
  });
  assert.equal(parsed.finalResponse, "partial answer");
  assert.equal(stopReasonFromOfficialSummary(parsed.summary), "error");
});
