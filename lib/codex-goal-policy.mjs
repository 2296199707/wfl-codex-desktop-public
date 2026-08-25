export const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;

export function codexGoalObjectiveLength(value) {
  return Array.from(String(value ?? "")).length;
}

export function assertCodexGoalObjective(params) {
  if (
    !Object.prototype.hasOwnProperty.call(params || {}, "objective")
    || params?.objective === null
  ) {
    return;
  }
  if (typeof params.objective !== "string" || !params.objective.trim()) {
    throw goalInputError("Goal 目标不能为空");
  }
  if (codexGoalObjectiveLength(params.objective.trim()) > CODEX_GOAL_OBJECTIVE_MAX_LENGTH) {
    throw goalInputError(`Goal 目标不能超过 ${CODEX_GOAL_OBJECTIVE_MAX_LENGTH} 字`);
  }
}

function goalInputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
