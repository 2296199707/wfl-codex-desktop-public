import { installCodexUsernsProfile } from "../lib/codex-userns-profile.mjs";

try {
  const result = await installCodexUsernsProfile({
    command: process.env.CODEX_DESKTOP_CODEX_BIN || "codex",
  });
  if (result.installed) {
    console.log(`Installed the managed-user Codex sandbox profile for ${result.binaries.length} native binary.`);
  } else {
    console.log(`Codex sandbox profile is not required (${result.reason}).`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
