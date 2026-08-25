import fs from "node:fs/promises";
import path from "node:path";
import {
  commitCodexInstallRecovery,
  commitCodexInstallRollback,
  completeCodexInstallRecovery,
  prepareCodexInstallRecovery,
  restoreCodexInstallRecovery,
} from "../../lib/codex-install-recovery.mjs";
import { CodexUpdateStatusStore } from "../../lib/codex-update-status.mjs";

const packageRoot = process.env.TEST_CODEX_PACKAGE_ROOT;
const nativePackageRoot = path.join(path.dirname(packageRoot), "codex-linux-x64");
const nativeRoot = path.join(nativePackageRoot, "vendor", "x86_64-unknown-linux-musl");
await prepareCodexInstallRecovery({
  runtimeDirectory: process.env.TEST_RUNTIME_DIR,
  operationId: process.env.TEST_OPERATION_ID,
  command: process.env.TEST_CODEX_COMMAND,
  versionOutput: `codex-cli ${process.env.TEST_BEFORE_VERSION}`,
  appVersion: process.env.TEST_APP_VERSION,
});
await fs.writeFile(
  path.join(packageRoot, "package.json"),
  `${JSON.stringify({ name: "@openai/codex", version: process.env.TEST_AFTER_VERSION })}\n`,
);
await fs.writeFile(
  path.join(nativePackageRoot, "package.json"),
  `${JSON.stringify({ name: "@openai/codex-linux-x64", version: process.env.TEST_AFTER_VERSION })}\n`,
);
await fs.writeFile(
  path.join(nativeRoot, "codex-package.json"),
  `${JSON.stringify({
    layoutVersion: 1,
    version: process.env.TEST_AFTER_VERSION,
    target: "x86_64-unknown-linux-musl",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  })}\n`,
);
await fs.writeFile(path.join(packageRoot, "new-only.txt"), "partially installed update\n");
if (process.env.TEST_CRASH_MODE === "update-cleanup") {
  await commitCodexInstallRecovery(
    process.env.TEST_RUNTIME_DIR,
    `codex-cli ${process.env.TEST_AFTER_VERSION}`,
  );
  await new CodexUpdateStatusStore(process.env.TEST_STATE_DIR).write({
    status: "completed",
    phase: "completed",
    beforeVersion: `codex-cli ${process.env.TEST_BEFORE_VERSION}`,
    afterVersion: `codex-cli ${process.env.TEST_AFTER_VERSION}`,
    detail: "Committed update cleanup test",
    completedAt: Date.now(),
    error: null,
  });
  await completeCodexInstallRecovery(process.env.TEST_RUNTIME_DIR, {
    beforeJournalRemoval: waitForKill,
  });
} else if (process.env.TEST_CRASH_MODE === "rollback-cleanup") {
  await restoreCodexInstallRecovery({ runtimeDirectory: process.env.TEST_RUNTIME_DIR });
  await commitCodexInstallRollback(process.env.TEST_RUNTIME_DIR);
  await new CodexUpdateStatusStore(process.env.TEST_STATE_DIR).write({
    status: "failed",
    phase: "failed",
    beforeVersion: `codex-cli ${process.env.TEST_BEFORE_VERSION}`,
    detail: "Committed rollback cleanup test",
    completedAt: Date.now(),
    error: "Rollback committed before cleanup",
  });
  await completeCodexInstallRecovery(process.env.TEST_RUNTIME_DIR, {
    beforeJournalRemoval: waitForKill,
  });
} else {
  await waitForKill();
}

async function waitForKill() {
  process.stdout.write("READY\n");
  await new Promise(() => setInterval(() => {}, 60_000));
}
