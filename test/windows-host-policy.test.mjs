import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWindowsHostCall,
  normalizeWorkspaceRelativePath,
} from "../lib/windows-host-policy.mjs";

test("Windows Codex calls use a fixed method and field allowlist", () => {
  assert.deepEqual(normalizeWindowsHostCall("windows-codex-remote", "codex.thread.resume", {
    projectId: "project-1",
    threadId: "thread-1",
  }), { projectId: "project-1", threadId: "thread-1" });
  assert.throws(() => normalizeWindowsHostCall("windows-codex-remote", "shell.exec", {
    command: "powershell.exe",
  }), /不允许/);
  assert.throws(() => normalizeWindowsHostCall("windows-codex-remote", "codex.thread.resume", {
    projectId: "project-1",
    threadId: "thread-1",
    userId: "other-user",
  }), /未允许字段/);
});

test("creator workspace paths cannot escape or name Windows devices", () => {
  assert.equal(normalizeWorkspaceRelativePath("media\\intro.mp4"), "media/intro.mp4");
  for (const unsafe of [
    "../secret",
    "C:\\Windows\\System32",
    "/etc/passwd",
    "folder/../../secret",
    "CON",
    "con.txt",
    "AUX",
    "LPT1.log",
    "folder.",
    "folder ",
    "it's/file.txt",
  ]) {
    assert.throws(() => normalizeWorkspaceRelativePath(unsafe), /路径/);
  }
});

test("creator jobs accept structured recipes but reject arbitrary commands", () => {
  const job = normalizeWindowsHostCall("creator-worker", "creator.job.run", {
    jobId: "job-1",
    kind: "presentation.generate",
    workspacePath: ".",
    spec: {
      output: "exports/launch.pptx",
      title: "Launch plan",
      theme: "business",
      slides: [{ title: "Overview", bullets: ["One", "Two"] }],
    },
  });
  assert.equal(job.kind, "presentation.generate");
  assert.equal(job.spec.output, "exports/launch.pptx");
  assert.throws(() => normalizeWindowsHostCall("creator-worker", "creator.job.run", {
    jobId: "job-2",
    kind: "media.transcode",
    workspacePath: ".",
    spec: {
      input: "input.mov",
      output: "output.mp4",
      quality: "high",
      command: "ffmpeg -i input.mov output.mp4",
    },
  }), /未允许字段/);
  assert.throws(() => normalizeWindowsHostCall("creator-worker", "creator.job.run", {
    jobId: "job-3",
    kind: "custom.exec",
    workspacePath: ".",
    spec: {},
  }), /不受支持/);
  assert.throws(() => normalizeWindowsHostCall("creator-worker", "creator.job.run", {
    jobId: "job-4",
    kind: "video.compose",
    workspacePath: ".",
    spec: {
      output: "video.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
      clips: [{ path: "clip.mp4" }],
      titles: [{ text: "unsafe title", startMs: 0, durationMs: 1_000 }],
    },
  }), /暂不支持/);
});

test("creator text writes are bounded and cannot silently overwrite", () => {
  const call = normalizeWindowsHostCall("creator-worker", "creator.workspace.writeText", {
    path: "notes/plan.md",
    content: "hello",
    overwrite: false,
  });
  assert.deepEqual(call, { path: "notes/plan.md", content: "hello", overwrite: false });
  assert.throws(() => normalizeWindowsHostCall("creator-worker", "creator.workspace.writeText", {
    path: "notes/plan.md",
    content: "hello",
    overwrite: false,
    shell: true,
  }), /未允许字段/);
});
