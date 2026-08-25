import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsCreatorHost } from "../companion/windows-host/src/creator-host.mjs";

test("Windows Creator Host confines text operations to a real workspace tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-host-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-outside-"));
  try {
    const host = await new WindowsCreatorHost({ workspaceRoot: root }).initialize();
    const written = await host.call("creator.workspace.writeText", {
      path: "notes/plan.md",
      content: "safe text",
      overwrite: false,
    });
    assert.equal(written.path, "notes/plan.md");
    assert.deepEqual(await host.call("creator.workspace.readText", { path: "notes/plan.md" }), {
      path: "notes/plan.md",
      content: "safe text",
    });
    await assert.rejects(host.call("creator.workspace.writeText", {
      path: "notes/plan.md",
      content: "unexpected overwrite",
      overwrite: false,
    }), /exist/i);

    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, path.join(root, "linked"));
    await assert.rejects(host.call("creator.workspace.readText", { path: "linked/secret.txt" }), /real directory|symlink/i);
  } finally {
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("Windows Creator Host publishes allowlisted tool output without overwriting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-host-"));
  try {
    await fs.mkdir(path.join(root, "media"));
    await fs.writeFile(path.join(root, "media", "input.mov"), "input");
    const host = await new WindowsCreatorHost({ workspaceRoot: root }).initialize();
    host.tools.ffmpeg = "ffmpeg";
    let invoked = null;
    host.runProcess = async (_entry, command, args) => {
      invoked = { command, args };
      await fs.writeFile(args.at(-1), "generated video", { flag: "wx" });
    };

    const result = await host.call("creator.job.run", {
      jobId: "job-transcode",
      kind: "media.transcode",
      workspacePath: ".",
      spec: {
        input: "media/input.mov",
        output: "exports/output.webm",
        quality: "balanced",
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(await fs.readFile(path.join(root, "exports", "output.webm"), "utf8"), "generated video");
    assert.equal(invoked.command, "ffmpeg");
    assert.ok(invoked.args.includes("-n"));
    assert.ok(!invoked.args.includes("-y"));
    assert.ok(invoked.args.includes("libvpx-vp9"));
    assert.notEqual(invoked.args.at(-1), path.join(root, "exports", "output.webm"));

    let secondInvocation = false;
    host.runProcess = async () => { secondInvocation = true; };
    await assert.rejects(host.call("creator.job.run", {
      jobId: "job-overwrite",
      kind: "media.transcode",
      workspacePath: ".",
      spec: {
        input: "media/input.mov",
        output: "exports/output.webm",
        quality: "high",
      },
    }), /already exists/);
    assert.equal(secondInvocation, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
