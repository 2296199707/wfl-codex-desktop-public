import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { publishImmutableArchive } from "../lib/immutable-archive-publisher.mjs";

const OWNER_COMMAND = "test/immutable-archive-publisher.test.mjs";
const ACCEPTED_COMMANDS = [OWNER_COMMAND];

test("serializes concurrent publication and preserves one verified archive pair", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-archive-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.tar.gz");
  const archive = path.join(directory, "release.tar.gz");
  const checksum = `${archive}.sha256`;
  const content = Buffer.from("immutable release archive\n");
  await fs.writeFile(source, content);

  const options = {
    sourceArchive: source,
    destinationArchive: archive,
    destinationChecksum: checksum,
    archiveName: "release.tar.gz",
    ownerCommand: OWNER_COMMAND,
    acceptedCommands: ACCEPTED_COMMANDS,
    lockWaitMs: 5_000,
  };
  const [firstDigest, secondDigest] = await Promise.all([
    publishImmutableArchive(options),
    publishImmutableArchive(options),
  ]);
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  assert.equal(firstDigest, digest);
  assert.equal(secondDigest, digest);
  assert.deepEqual(await fs.readFile(archive), content);
  assert.equal((await fs.readFile(checksum, "utf8")).split(/\s+/u)[0], digest);
  await assert.rejects(fs.access(`${archive}.publish.lock`), { code: "ENOENT" });
});

test("rejects a different concurrent source without replacing the accepted archive", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-archive-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceA = path.join(directory, "source-a.tar.gz");
  const sourceB = path.join(directory, "source-b.tar.gz");
  const archive = path.join(directory, "release.tar.gz");
  const checksum = `${archive}.sha256`;
  const contentA = Buffer.from("release A\n");
  const contentB = Buffer.from("release B\n");
  await Promise.all([fs.writeFile(sourceA, contentA), fs.writeFile(sourceB, contentB)]);

  const makeOptions = (source) => ({
    sourceArchive: source,
    destinationArchive: archive,
    destinationChecksum: checksum,
    archiveName: "release.tar.gz",
    ownerCommand: OWNER_COMMAND,
    acceptedCommands: ACCEPTED_COMMANDS,
    lockWaitMs: 5_000,
  });
  const results = await Promise.allSettled([
    publishImmutableArchive(makeOptions(sourceA)),
    publishImmutableArchive(makeOptions(sourceB)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const acceptedContent = await fs.readFile(archive);
  assert.ok(acceptedContent.equals(contentA) || acceptedContent.equals(contentB));
  const digest = crypto.createHash("sha256").update(acceptedContent).digest("hex");
  assert.equal((await fs.readFile(checksum, "utf8")).split(/\s+/u)[0], digest);
});

test("does not create an archive beside an incompatible orphan checksum", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-archive-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.tar.gz");
  const archive = path.join(directory, "release.tar.gz");
  const checksum = `${archive}.sha256`;
  await fs.writeFile(source, "new archive\n");
  await fs.writeFile(checksum, `${"0".repeat(64)}  release.tar.gz\n`);

  await assert.rejects(
    publishImmutableArchive({
      sourceArchive: source,
      destinationArchive: archive,
      destinationChecksum: checksum,
      archiveName: "release.tar.gz",
      ownerCommand: OWNER_COMMAND,
      acceptedCommands: ACCEPTED_COMMANDS,
    }),
    /Existing release checksum is not compatible/u,
  );
  await assert.rejects(fs.access(archive), { code: "ENOENT" });
  assert.match(await fs.readFile(checksum, "utf8"), /^0{64}/u);
});
