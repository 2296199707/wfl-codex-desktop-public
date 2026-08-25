import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ImageSecureInputError,
  readSecureProjectImage,
  stageSecureProjectImage,
} from "../lib/image-secure-input.mjs";

async function temporaryProject(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-secure-input-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function expectSecureInputError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ImageSecureInputError);
    assert.equal(error.code, code);
    return true;
  });
}

test("reads a regular project image through one bounded file handle", async (t) => {
  const project = await temporaryProject(t);
  const target = path.join(project, "source.bin");
  await fs.writeFile(target, Buffer.from("project image"));

  const result = await readSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: target,
    relativePath: "source.bin",
    maxBytes: 1024,
  });

  assert.equal(result.path, target);
  assert.equal(result.data.toString(), "project image");
  assert.equal(result.stat.isFile(), true);
});

test("rejects final image symlinks even when they stay inside the project", async (t) => {
  const project = await temporaryProject(t);
  await fs.writeFile(path.join(project, "real.bin"), "inside");
  const target = path.join(project, "linked.bin");
  await fs.symlink("real.bin", target);

  await expectSecureInputError(readSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: target,
    relativePath: "linked.bin",
    maxBytes: 1024,
  }), "SYMLINK");
});

test("rejects parent-directory symlinks that redirect within the project", async (t) => {
  const project = await temporaryProject(t);
  await fs.mkdir(path.join(project, "actual"));
  await fs.writeFile(path.join(project, "actual", "source.bin"), "redirected");
  await fs.symlink("actual", path.join(project, "alias"));

  await expectSecureInputError(readSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: path.join(project, "alias", "source.bin"),
    relativePath: "alias/source.bin",
    maxBytes: 1024,
  }), "SYMLINK");
});

test("rejects parent-directory symlinks that escape the project", async (t) => {
  const project = await temporaryProject(t);
  const outside = await temporaryProject(t);
  await fs.writeFile(path.join(outside, "source.bin"), "outside");
  await fs.symlink(outside, path.join(project, "alias"));

  await expectSecureInputError(readSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: path.join(project, "alias", "source.bin"),
    relativePath: "alias/source.bin",
    maxBytes: 1024,
  }), "SYMLINK");
});

test("enforces the byte limit while reading from the opened file", async (t) => {
  const project = await temporaryProject(t);
  const target = path.join(project, "large.bin");
  await fs.writeFile(target, Buffer.alloc(1025));

  await expectSecureInputError(readSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: target,
    relativePath: "large.bin",
    maxBytes: 1024,
  }), "TOO_LARGE");
});

test("streams a verified source fd to a private staged file with SHA-256 metadata", async (t) => {
  const project = await temporaryProject(t);
  const staging = await temporaryProject(t);
  const source = path.join(project, "source.bin");
  const destination = path.join(staging, "staged.bin");
  const data = Buffer.alloc((64 * 1024 * 3) + 17, 0x5a);
  await fs.writeFile(source, data);

  const result = await stageSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: source,
    relativePath: "source.bin",
    maxBytes: data.length,
    destinationPath: destination,
  });

  const [sourceStat, destinationStat] = await Promise.all([fs.stat(source), fs.stat(destination)]);
  assert.equal(result.path, source);
  assert.equal(result.sourcePath, source);
  assert.equal(result.destinationPath, destination);
  assert.equal(result.relativePath, "source.bin");
  assert.equal(result.size, data.length);
  assert.equal(result.sha256, crypto.createHash("sha256").update(data).digest("hex"));
  assert.deepEqual(await fs.readFile(destination), data);
  assert.deepEqual(result.source, { dev: sourceStat.dev, ino: sourceStat.ino, mode: sourceStat.mode & 0o777 });
  assert.deepEqual(result.destination, {
    dev: destinationStat.dev,
    ino: destinationStat.ino,
    mode: 0o600,
  });
  assert.equal(destinationStat.mode & 0o777, 0o600);
});

test("staging rejects source file and parent-directory symlinks without creating output", async (t) => {
  const project = await temporaryProject(t);
  const staging = await temporaryProject(t);
  await fs.mkdir(path.join(project, "actual"));
  await fs.writeFile(path.join(project, "actual", "source.bin"), "source");
  await fs.symlink("actual/source.bin", path.join(project, "linked.bin"));
  await fs.symlink("actual", path.join(project, "alias"));

  for (const relativePath of ["linked.bin", "alias/source.bin"]) {
    const destination = path.join(staging, `${relativePath.replace("/", "-")}.stage`);
    await expectSecureInputError(stageSecureProjectImage({
      projectRealPath: await fs.realpath(project),
      targetPath: path.join(project, ...relativePath.split("/")),
      relativePath,
      maxBytes: 1024,
      destinationPath: destination,
    }), "SYMLINK");
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  }
});

test("staging enforces the source limit and leaves no partial destination", async (t) => {
  const project = await temporaryProject(t);
  const staging = await temporaryProject(t);
  const source = path.join(project, "large.bin");
  const destination = path.join(staging, "large.stage");
  await fs.writeFile(source, Buffer.alloc(1025));

  await expectSecureInputError(stageSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: source,
    relativePath: "large.bin",
    maxBytes: 1024,
    destinationPath: destination,
  }), "TOO_LARGE");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("staging refuses existing files and destination symlinks without changing them", async (t) => {
  const project = await temporaryProject(t);
  const staging = await temporaryProject(t);
  const source = path.join(project, "source.bin");
  const existing = path.join(staging, "existing.stage");
  const linked = path.join(staging, "linked.stage");
  await fs.writeFile(source, "source");
  await fs.writeFile(existing, "keep");
  await fs.symlink("existing.stage", linked);
  const input = {
    projectRealPath: await fs.realpath(project),
    targetPath: source,
    relativePath: "source.bin",
    maxBytes: 1024,
  };

  await expectSecureInputError(stageSecureProjectImage({ ...input, destinationPath: existing }), "DESTINATION_EXISTS");
  await expectSecureInputError(stageSecureProjectImage({ ...input, destinationPath: linked }), "DESTINATION_SYMLINK");
  assert.equal(await fs.readFile(existing, "utf8"), "keep");
  assert.equal(await fs.readlink(linked), "existing.stage");
});

test("staging removes a newly created file when its destination parent redirects", async (t) => {
  const project = await temporaryProject(t);
  const staging = await temporaryProject(t);
  const actual = path.join(staging, "actual");
  await fs.mkdir(actual);
  await fs.symlink("actual", path.join(staging, "alias"));
  const source = path.join(project, "source.bin");
  const destination = path.join(staging, "alias", "partial.stage");
  const redirectedDestination = path.join(actual, "partial.stage");
  await fs.writeFile(source, "source");

  await expectSecureInputError(stageSecureProjectImage({
    projectRealPath: await fs.realpath(project),
    targetPath: source,
    relativePath: "source.bin",
    maxBytes: 1024,
    destinationPath: destination,
  }), "DESTINATION_SYMLINK");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  await assert.rejects(fs.stat(redirectedDestination), { code: "ENOENT" });
});
