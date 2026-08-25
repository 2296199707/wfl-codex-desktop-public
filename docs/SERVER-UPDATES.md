# Safe updates on additional servers

Each server pulls release metadata and source through its own outbound Git
connection. No additional management port is required. A GitHub push never
changes a running server by itself.

## What is synchronized

Application tags synchronize program source, browser assets, locked dependency
metadata, tests, and service templates. The updater never copies these
server-local paths or values between machines:

- `.codex-desktop/` authentication, provider, plugin, recovery, and status records
- `.codex-runtime/` active slots, releases, locks, deployment settings, and temporary plugin keys
- `~/.codex/` login state and conversations
- project directories, uploads, environment files, and Cloudflare settings

Official Codex CLI updates remain a separate confirmed operation.

The owner rescue component is deliberately independent from the primary
application version. The current package includes rescue component `1.1.8`; it
uses private `4320/4321` slots and its own active-port file. A fresh install
stages rescue from the verified package, while an ordinary existing-server
main update never switches, restarts, or replaces rescue. Only an explicit
owner action in the rescue window or the guarded command below updates it.

## Repository access

The public stable repository can be cloned and fetched read-only over HTTPS
without credentials. Private mirrors may instead use a different read-only SSH
Deploy Key on every server; leave **Allow write access** disabled, keep the
private key outside the repository, and restrict it to mode `0600`.
Protect `main`, `stable`, and release tags in GitHub. Only the reviewed
candidate-promotion workflow may advance `stable` and create a `vX.Y.Z` tag.
Do not reuse or move either after publication.

The checkout must have an `origin` remote, a clean branch with an upstream, and
non-interactive read access:

```bash
cd /srv/wfl-codex-desktop
git status --short
git ls-remote --tags --refs origin 'v*'
```

The updater accepts stable `vMAJOR.MINOR.PATCH` tags only. The highest accepted
tag and `origin/stable` must identify the same commit, and the local `stable`
branch must be able to fast-forward to that exact commit. An untagged commit on
`main` is a candidate and is never offered through the ordinary update path.

## One-time safety transition

Servers running `v0.37.0` or `v0.37.1` need one manual transition to
`v0.37.2`. Those backends cannot report persistent HTTP, WebSocket, approval,
upload, or background writes, so the new release refuses to infer that the
server is idle. Finish all conversations and stop uploads, settings changes,
backups, migrations, and other writes. Then fetch the exact tag, run the full
checks, and explicitly acknowledge the legacy limitation:

```bash
cd /srv/wfl-codex-desktop
git fetch --prune --tags origin
git merge --ff-only v0.37.2
npm ci
npm run check
CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1 npm run release:wait
npm run server:doctor
```

If a version-center sync already tested and fast-forwarded the source before
stopping at the legacy confirmation gate, do not merge again; run the last two
commands from the clean `v0.37.2` checkout. The failed first attempt does not
create a drain and does not stop the active backend.

Do not set `CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED` permanently. Releases after
this transition require the complete live drain protocol and reject an
unsupported active backend by default.

Fresh servers do not need this bootstrap. Follow the public clone or verified
release-package workflow and run `sudo bash install.sh`. Package installs must
use `--git-remote` with that server's read-only deploy key to enable later
version-center updates.

## Routine updates

Open the version center on that server. **Remote stable** shows the latest tag
visible to its deploy key. **Sync update** starts an independent systemd worker
that continues if the browser or SSH session closes.

The worker performs these gates in order:

1. Reject dirty source, divergent history, concurrent releases, and concurrent
   official Codex updates.
2. Fetch tags and require the newest stable tag to match `origin/stable`.
3. Create a detached worktree under `.codex-runtime/update-sources/` and read
   the target release's `engines.node` requirement. An old Node runtime stops
   here before dependency installation, source fast-forward, or blue-green
   activation; the active backend remains selected.
4. Run `npm ci`, repair/verify the persistent Playwright Chromium cache, and run
   the focused host compatibility check in that isolated worktree. The full unit, integration, and Playwright suites already passed on
   the primary server and are bound to this exact commit by candidate evidence.
5. Fast-forward the control checkout only after those checks pass.
6. By default, perform the forced blue-green switch immediately after the
   candidate is ready; use `CODEX_DESKTOP_FORCE_UPDATE=0` for a one-off idle
   drain while conversation access remains available.
7. Start the candidate on the inactive `4318` or `4319` slot and require the
   expected version plus a successful Codex `thread/list` probe.
8. Switch the stable gateway only after verification. A separate watchdog
   restores the old verified backend or completes the candidate if the worker
   crashes, times out, restarts, or is killed during this final window.

The owner default is a forced maintenance switch; an in-flight task may be
interrupted. Set `CODEX_DESKTOP_FORCE_UPDATE=0` only for a one-off update that
must wait for the active task window to become idle.

本机所有者的长期偏好（2026-08-14）现已成为默认策略：主站或官方 Codex
更新采用强制切换，不等待运行中的任务空闲。只有本次明确要求“等待空闲”
时才设置 `CODEX_DESKTOP_FORCE_UPDATE=0` 使用普通 drain 流程。强制模式仍必须经过候选后端、版本/协议检查、蓝绿
切换、独立 watchdog 和就绪验证，不能绕过校验，也不改变冻结的 4321 救援窗口。

Equivalent SSH commands are:

```bash
npm run app:update:check
npm run app:update:wait
npm run app:update:status
```

`app:update:wait` only waits for the durable worker. Disconnecting that shell
does not cancel the update.

## Node.js compatibility across servers

The main site requires Node.js 22 or newer. Claude Code is a separately managed,
optional component and is not part of the main project's npm dependency tree.
Image processing depends on Sharp's platform-specific optional packages, so do
not use `npm ci --omit=optional`: it removes the native Sharp runtime. The
supported installer uses a normal locked `npm ci`; before it runs, an existing
bundled Claude installation is migrated atomically into the managed runtime
directory. Node.js 22 is installed from NodeSource only when the server does
not already have a supported Node.js and npm.

When a remote target raises its Node requirement, the current updater checks
the target manifest before `npm ci`, source fast-forward, or traffic switching.
On servers whose older updater predates this early gate, the target's own
offline quick check still runs in the detached worktree before source
fast-forward. In either case, an incompatible runtime does not replace the
running main-site source or select a candidate backend. Upgrade Node explicitly
through the supported server installer, then retry the same stable tag.

The npm executable is resolved through the bounded systemd worker `PATH`; it is
not assumed to be `/usr/bin/npm`. This keeps NodeSource, `/usr/local`, and other
administrator-selected Node 22 layouts compatible without changing the server's
active release.

## Rescue component updates

If the bundled rescue synchronization needs a retry, open the owner-only rescue
window and use its guarded component-update control, or run:

```bash
sudo npm run server:rescue-update
```

The worker accepts only the currently active verified stable package with the
dual-slot rescue capability. It updates the inactive rescue slot, requires its
direct readiness response, switches the gateway's rescue active-port pointer,
and then stops the old slot. The old target remains available for rollback, and
any failure before or after the switch restores the previous active port.
For the first upgrade from a legacy single rescue slot, run the CLI command;
that older rescue UI cannot offer a control that did not yet exist. Later
updates can use either path. Rescue updates are always forced and do not wait
for active tasks or persistent writes; active rescue tasks may be interrupted
or lost. The worker still requires a strictly newer component version, verifies
the inactive slot, and restores the old slot if verification or switching fails.

## Failure handling

A fetch, dependency, test, backup, or staging failure leaves the active backend
running. A failure during the final stop-first switch is handled by the durable
deployment journal and independent watchdog. In force mode an in-flight task may
already have been interrupted, but the gateway either restores the old backend
or completes the verified candidate.
The same **Sync update** button then revalidates the prepared stable tag and
retries the checked switch without exposing a second deployment action.

Inspect bounded browser-safe progress in the version center or with
`npm run app:update:status`. Detailed command output stays in the systemd
journal and is not returned to the browser. Use `npm run release:status` for the
candidate deployment phase and `npm run server:doctor` after recovery.

Remote updates are manual in this release. Do not add an unattended timer until
canary rollout, post-switch observation, and automatic rollback are enabled.
