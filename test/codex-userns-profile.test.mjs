import assert from "node:assert/strict";
import test from "node:test";
import { renderCodexUsernsProfile } from "../lib/codex-userns-profile.mjs";

test("Codex bubblewrap userns permission is limited to a child profile", () => {
  const binary = "/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex";
  const profile = renderCodexUsernsProfile([binary]);
  assert.match(profile, /profile wfl-codex-native-1/);
  assert.match(profile, /\/usr\/bin\/bwrap px -> wfl-codex-bwrap-1/);
  assert.match(profile, /  profile wfl-codex-bwrap-1 \/usr\/bin\/bwrap flags=\(unconfined\)/);
  assert.doesNotMatch(profile, /^profile wfl-codex-bwrap/m);
});

test("AppArmor attachment paths reject profile syntax characters", () => {
  assert.throws(
    () => renderCodexUsernsProfile(['/tmp/codex" flags=(unconfined)']),
    /not safe/,
  );
});
