import fs from "node:fs/promises";
import path from "node:path";
import { acquireOperationLock } from "../../lib/operation-lock.mjs";

const [runtimeDirectory, operationKind, operationId] = process.argv.slice(2);
const definitions = {
  "app-update": {
    file: "app-update.lock",
    ownerCommand: "scripts/update-app.mjs",
    acceptedCommands: ["scripts/update-app.mjs"],
  },
  "codex-update": {
    file: "codex-update.lock",
    ownerCommand: "scripts/update-codex.mjs",
    acceptedCommands: ["scripts/update-codex.mjs"],
  },
  release: {
    file: "release.lock",
    ownerCommand: "scripts/release.mjs",
    acceptedCommands: ["scripts/release.mjs", "scripts/rollback.mjs"],
  },
  restore: {
    file: "backup-restore.lock",
    ownerCommand: "scripts/restore-data-backup.mjs",
    acceptedCommands: ["scripts/restore-data-backup.mjs", "scripts/recover-data-restore.mjs"],
  },
};

const definition = definitions[operationKind];
if (!runtimeDirectory || !definition || !operationId) throw new Error("Invalid maintenance lock fixture arguments");
await fs.mkdir(runtimeDirectory, { recursive: true });
const lock = await acquireOperationLock(path.join(runtimeDirectory, definition.file), {
  ownerCommand: definition.ownerCommand,
  acceptedCommands: definition.acceptedCommands,
  requiredArguments: ["--worker"],
  operationId,
});

process.stdout.write(`${JSON.stringify({ ready: true, operationId })}\n`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await lock.release().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1_000);
