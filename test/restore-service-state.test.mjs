import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRestoreDataServicesInactive,
  RESTORE_DATA_SERVICE_UNITS,
} from "../lib/restore-service-state.mjs";

const activeBackend = "wfl-codex-desktop-backend@4318.service";
const candidateBackend = "wfl-codex-desktop-backend@4319.service";
const legacyBackend = "wfl-codex-desktop.service";

test("an orphan candidate blocks restore before the active backend drain", async () => {
  await assert.rejects(
    assertRestoreDataServicesInactive({
      allowedActiveUnits: [activeBackend],
      readState: stateReader({
        [activeBackend]: "active",
        [candidateBackend]: "active",
        [legacyBackend]: "inactive",
      }),
    }),
    (error) => error.code === "ERR_RESTORE_DATA_SERVICE_ACTIVE"
      && error.message.includes(candidateBackend),
  );
});

test("an active legacy backend blocks every restore directory swap", async () => {
  await assert.rejects(
    assertRestoreDataServicesInactive({
      allowedActiveUnits: [activeBackend],
      readState: stateReader({
        [activeBackend]: "active",
        [candidateBackend]: "inactive",
        [legacyBackend]: "active",
      }),
    }),
    (error) => error.code === "ERR_RESTORE_DATA_SERVICE_ACTIVE"
      && error.message.includes(legacyBackend),
  );
});

test("only the selected active backend may remain running before drain", async () => {
  const states = await assertRestoreDataServicesInactive({
    allowedActiveUnits: [activeBackend],
    readState: stateReader({
      [activeBackend]: "active",
      [candidateBackend]: "inactive",
      [legacyBackend]: "unknown",
    }),
  });
  assert.equal(states.length, RESTORE_DATA_SERVICE_UNITS.length);
});

function stateReader(states) {
  return async (unit) => states[unit];
}
