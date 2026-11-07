# Rescue Window Recovery (2026-09-09)

## Scope

The owner explicitly requested diagnosis and repair of the frozen rescue window.
Do not deploy the main site, upgrade the rescue component, change its port or
symlink, or delete conversation data for this repair.

## Confirmed Diagnosis

- Service: `wfl-codex-desktop-rescue@4321.service`, PID `768307`, running since
  `2026-08-25 15:58:47 UTC`.
- Frozen component: `1.1.16`, source release `0.44.55`.
- Existing slot: `.codex-runtime/rescue-slots/4321` points to
  `.codex-runtime/releases/v0.44.55-7cee544ef285`.
- That release directory is missing. `/proc/768307/cwd` ends with `(deleted)`.
- Authenticated `GET /rescue/` and `GET /rescue/assets/rescue.js` through the
  gateway both return `404`. The authenticated health API still returns `200`.
- `/internal/codex-ready` passes, including `threadListReady: true`, and reports
  the original Codex `0.149.0`. The missing static files, not the main-site
  Codex upgrade, explain the current page-open failure.
- The deletion operation and its time are not established by these checks.
- The original Git commit is available:
  `7cee544ef2851df8e3e77c967b683019517a7063`, tree
  `2016b6b84c6b04884be81b1dee822c1efcdd912c`.

## Recovery Progress

- [x] Confirm the missing release and distinguish it from a Codex bridge failure.
- [x] Restore the original release files from the recorded commit.
- [x] Verify authenticated page, assets, WebSocket, and history reads.
- [x] Confirm the main backend, rescue version, slot, and running process remain unchanged.

The restored tree passed checks for 1,691 tracked files; 118 Android text files
use CRLF as required by their Git attributes. All other file bytes match the
original Git blobs. The dependency lockfile matches the current shared
`node_modules` lock apart from the top-level application version. The package
manifest was recreated using the original manifest schema and commit timestamp.
Files were staged and moved to the missing original path without changing the
slot symlink or restarting either service. Authenticated HTML, JS, CSS, and
health requests through the gateway now return `200`.

## Verification Results

- The real HTTPS route `https://mofen.fun/rescue/` renders in Chromium at
  `1440x900` and `390x844`; both the connection and composer reach `ready`.
- No page runtime errors, failed rescue resources, or horizontal overflow were
  observed. Model and project selectors populated; entering a draft enabled
  the send button. The draft was cleared without sending a model request.
- The public `wss://mofen.fun/rescue/ws` route completed `thread/list` and
  `thread/read` with `includeTurns: true`. One existing conversation was read.
- The first standalone diagnostic WebSocket request omitted `generation` and
  was rejected with `400` ("WebSocket identity is incomplete"). Supplying the
  same identity fields as the browser fixed the diagnostic, not production code.
- Rescue still uses Codex `0.149.0`, with its binary in the retained immutable
  `.codex-runtime/codex-runtimes/0.149.0-63e477da02761eab86e0e8b3eed8f7a89ab4ad69d3de62eca88536ecb7b91031/` bundle.
- Rescue PID `768307`, main backend PID `2525478` on `4318`, and gateway PID
  `247639` were preserved. No service was restarted, no rescue slot was changed,
  and no package/component version or authentication setting was changed.
- The existing process retains its old deleted working-directory inode until
  its next normal restart. Absolute application paths have been restored and
  the Codex child uses the separate existing rescue project directory. A
  restart was not needed for the verified page, RPC, and history recovery.
- Screenshots and the bounded, read-only diagnostic are in
  `/tmp/wfl-rescue-recovery-20260909-iP4soc39/`. They contain no credentials;
  the diagnostic reads the existing owner session token in memory only.

No full test suite, model generation, main-site deployment, or Git push was run.

## Retention Rule

Release directories referenced by rescue slot symlinks or running service
working directories are live production data, regardless of age or main-site
version. Disk cleanup must protect both the slot links and their resolved
targets. Do not delete a directory just because it is older than the main-site
rollback retention count.
