import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertClaudeCompatible, inspectClaudeCompatibility } from "../lib/claude-compatibility.mjs";

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const command = process.env.CODEX_DESKTOP_CLAUDE_BIN
  || path.join(sourceDirectory, "scripts", "claude-command");
const reportOnly = process.argv.includes("--report");

try {
  const snapshot = reportOnly
    ? await inspectClaudeCompatibility({ command, projectDirectory: sourceDirectory })
    : await assertClaudeCompatible({ command, projectDirectory: sourceDirectory });
  console.log(JSON.stringify(snapshot, null, 2));
} catch (error) {
  const snapshot = error?.snapshot || {
    compatible: false,
    state: "unavailable",
    error: "Claude compatibility check failed; raw diagnostics were hidden",
  };
  console.error(JSON.stringify(snapshot, null, 2));
  process.exitCode = 1;
}
