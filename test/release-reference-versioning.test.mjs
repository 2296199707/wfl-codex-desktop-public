import assert from "node:assert/strict";
import test from "node:test";
import { versionReleaseReferences } from "../lib/release-reference-versioning.mjs";

test("release version synchronization preserves archive and checksum suffixes", () => {
  const source = [
    "wfl-codex-desktop-v0.43.33-beta.tar.gz",
    "wfl-codex-desktop-v0.43.33-beta.tar.gz.sha256",
    "/srv/wfl-codex-desktop-v0.43.33-beta/",
  ].join("\n");
  assert.equal(versionReleaseReferences(source, "0.43.34-beta"), [
    "wfl-codex-desktop-v0.43.34-beta.tar.gz",
    "wfl-codex-desktop-v0.43.34-beta.tar.gz.sha256",
    "/srv/wfl-codex-desktop-v0.43.34-beta/",
  ].join("\n"));
});

test("release version synchronization handles dotted prereleases without consuming filenames", () => {
  assert.equal(
    versionReleaseReferences(
      "`wfl-codex-desktop-v1.2.3-rc.4.tar.gz.sha256`",
      "2.0.0-beta.1",
    ),
    "`wfl-codex-desktop-v2.0.0-beta.1.tar.gz.sha256`",
  );
});
