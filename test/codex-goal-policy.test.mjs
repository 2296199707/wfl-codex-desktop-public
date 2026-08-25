import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCodexGoalObjective,
  codexGoalObjectiveLength,
  CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
} from "../lib/codex-goal-policy.mjs";

test("Goal objectives enforce the browser's 4,000-character boundary", () => {
  assert.equal(CODEX_GOAL_OBJECTIVE_MAX_LENGTH, 4_000);
  assert.doesNotThrow(() => assertCodexGoalObjective({ objective: "x".repeat(4_000) }));
  assert.equal(codexGoalObjectiveLength("中文🙂\n"), 4);
  assert.doesNotThrow(() => assertCodexGoalObjective({ objective: "🙂".repeat(4_000) }));
  assert.throws(
    () => assertCodexGoalObjective({ objective: "🙂".repeat(4_001) }),
    (error) => error.statusCode === 400 && /不能超过 4000 字/.test(error.message),
  );
  assert.doesNotThrow(() => assertCodexGoalObjective({ status: "paused" }));
  assert.doesNotThrow(() => assertCodexGoalObjective({ objective: null, status: "paused" }));
  assert.throws(
    () => assertCodexGoalObjective({ objective: "x".repeat(4_001) }),
    (error) => error.statusCode === 400 && /不能超过 4000 字/.test(error.message),
  );
  assert.throws(
    () => assertCodexGoalObjective({ objective: "   " }),
    (error) => error.statusCode === 400 && /不能为空/.test(error.message),
  );
});
