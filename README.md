# WFL Codex Web Workspace

[English](README.md) | [简体中文](README.zh-CN.md)

A browser-based workspace backed by the installed Codex `app-server`. It uses
Codex's own thread, model, configuration, and approval
protocols instead of reading the local SQLite database.

Current release: `v0.44.64`. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Quick server installation

Use a clean Debian or Ubuntu server with systemd, root access, and at least
2 GiB of free disk space. A fresh install needs outbound access to:

- the configured Debian or Ubuntu APT repositories for operating-system packages;
- `registry.npmjs.org` (or the configured npm registry) for locked application dependencies;
- `cdn.playwright.dev` for the matching Playwright Chromium build;
- GitHub when cloning the public repository or checking synchronized updates; and
- `deb.nodesource.com` only when supported Node.js and npm are not already installed;
  the installer uses it to install Node.js 22.

The installer first tries `https://chatgpt.com/codex/install.sh` for the
official Codex CLI. If that endpoint is blocked or unavailable, it falls back
to the official `@openai/codex` package from the npm registry. The npm registry
is still required for the application dependencies, so these two Codex sources
are not alternative network requirements. The guided installer also installs
Chromium, systemd services, and the initial web password. Do not install these
components by hand first.

Clone the public stable branch over HTTPS; no GitHub account, token, or Deploy
Key is required:

```bash
sudo -i
apt-get update
apt-get install -y git ca-certificates
git clone --branch stable https://github.com/2296199707/wfl-codex-desktop-public.git /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
git status --short
git describe --tags --exact-match
sudo bash install.sh
```

`git status --short` must print nothing and `git describe` must print the
current release tag. The single `install.sh` command opens the guided setup for
Codex authorization, the owner web password, and one of three browser access
modes: an existing HTTPS domain, Cloudflare Tunnel, or local/SSH forwarding.
Do not expose ports `4317-4321` directly to the Internet.

After installation, verify the host with:

```bash
cd /srv/wfl-codex-desktop
npm run server:doctor
npm run release:status
```

For Windows SSH forwarding, keep this PowerShell command running and open
`http://127.0.0.1:4317` locally:

```powershell
ssh -p 22 -N -L 4317:127.0.0.1:4317 root@SERVER_IP
```

Replace `22` with the actual SSH port. See the
[Chinese deployment guide](docs/server-deployment.zh-CN.md) for Deploy Key,
release-package, domain, Cloudflare, update, and troubleshooting details.

Workspace transfer: [工作区迁移](docs/workspace-migration.zh-CN.md).

The interface keeps long threads manageable by opening at the latest message
and collapsing older turns. The project and thread panes can be hidden from the
command bar. Optional CPU, memory, and disk metrics are available in the status
bar. The composer accepts project-scoped file and image uploads, and exposes an
image-generation mode when the active Codex provider reports that capability.
Existing projects can also be imported from a guarded `.tar.gz` archive without
using SSH or a server file manager.
Optional Windows Codex Remote and Creator Worker plugins connect a personal
Windows PC outbound-only after explicit per-user authorization. They can resume
confirmed-idle local Codex Threads or run structured document, presentation,
media, and Godot jobs inside a selected workspace, without desktop takeover or
an arbitrary administrator shell. See the
[Windows Host guide](docs/WINDOWS-HOST.zh-CN.md).
On phones, separate camera/gallery and file controls keep image selection
direct, while secondary conversation actions are grouped under a compact menu.
Conversation controls support session-tree branch switching, local pinning,
copying IDs, deletion, and active-task termination. The project resource
explorer browses and searches files with read-only text and image previews.
It can open `.tmj` files in an on-demand Tiled JSON map editor for desktop,
tablet, and phone workflows. External `.tsj`, image, audio, and HTML resources
remain separate files; map edits support layers, tiles, objects, collisions,
undo, version conflicts, and chunked atomic saves. AI edits require an explicit
prompt copy, pasted structured patch, preview, and confirmation; they never call
chat or save the file automatically.
Game projects keep HTML, scripts, styles, images, audio, and maps as raw sibling
files. For local previews use `npm run preview-project -- /srv/wflgame`,
`npm run preview-file -- assets/hero.webp`, and
`npm run preview-capture -- http://127.0.0.1:4173 --output game.png`; the tools
bind to loopback by default and the capture worker blocks private or unauthorized
cross-origin targets.
In-app project captures use the same isolated Render Worker queue and the
administrator's manual screenshot concurrency, memory, and timeout settings;
capture failure or shutdown does not interrupt editing, saving, or chat.
For per-user, per-project, and per-window browser storage isolation, the
administrator can select per-session Origins in the operations center; that
mode requires DNS and a wildcard certificate for the configured preview base.
The operations center also includes a Tencent Cloud DNSPod and Let's Encrypt
DNS-01 wizard. It previews DNS mutations and checks DNS/TLS/HTTPS before an
owner confirms them; credentials stay in a server-side `0600` file. Automatic
wildcard setup requires a dedicated preview subdomain such as
`preview.example.com` and never takes over the zone-wide `*.example.com` name.
The command bar also includes an API provider center for switching between
Responses-compatible services without editing Codex configuration by hand.
The top-left WFL Codex switcher can open the independent Claude Code runtime.
Claude Code is optional on a fresh server: until an administrator installs the
reviewed component from the version center, the Claude workspace stays disabled
and Codex remains fully available. Existing bundled installations are retained.
Claude provider profiles are encrypted per user, the Claude CLI uses its native
stream-json session protocol, and the settings panel includes the
official Claude account login flow, MCP servers, personal Skills, custom
Agents, and user-scoped Plugins. New Claude conversations can optionally use a
native Worktree and project-scoped additional directories. Native background
Agents can inherit an explicitly selected draft's settings, MCP whitelist,
Plugins, Hooks, and extra directories without exposing stored secrets. Three
or more projects keep independent processes, accounts, providers, proxies,
pause state, and reconnect recovery. A Claude
compatibility center pins the reviewed CLI, option, permission, effort, and
stream-json surfaces, shows a path- and account-safe Doctor summary, blocks
native auto-updates, and rejects an unreviewed candidate during the bounded
update check. See the
[Claude Code administrator guide](docs/CLAUDE-CODE.zh-CN.md) and the generated
[2.1.236 capability matrix](docs/claude-code-2.1.236-coverage.md). New Codex
conversations can also start in an account-isolated managed Worktree, safely
handoff between Local and Worktree, create a formal branch, and retain
recoverable snapshots. Claude and Codex keep separate sessions; the independent
rescue window remains Codex-only.
The version center can discover the release whose tag matches the public
remote's `stable` branch and run dependency installation, a focused host
compatibility check, and a journaled dual-slot activation as one durable
server-side update. By default activation uses the forced blue-green switch
after candidate verification and does not wait for active tasks; an in-flight
task may be interrupted before the browser reconnects. Set
`CODEX_DESKTOP_FORCE_UPDATE=0` for a one-off maintenance window that waits for
active tasks to finish while conversation access stays available.
The chat header includes a recovery control that rebuilds the browser
connection and resumes the active thread when live updates appear stalled.
The current authority, recovery, multi-user isolation, and Sidecar boundaries
are recorded in [ADR-0002](docs/adr/0002-app-server-conversation-authority.zh-CN.md).
The conversation pane also includes a server-backed recovery center for recent
thread IDs and project paths when browser-local state has been lost. Recovery
metadata never includes prompts, responses, attachments, or tool output.
A compact task indicator in the existing status area independently reports
whether Codex is working, waiting for approval, finished, or temporarily unable
to refresh. The active conversation keeps its more precise live-turn status
below the composer without exposing prompt text, command contents, or provider
secrets.

An independent emergency window is available at `/rescue.html` and from the
life-buoy control in the main title bar. It keeps only project and conversation
switching, model selection, sending and stopping tasks, approvals, and API
provider management. Its HTML, JavaScript, and CSS do not import the main UI
bundles, so a main-window asset or cache failure does not disable the fallback.
Only the owner can authenticate to this service. It keeps checksum-protected
last-valid conversation snapshots for read-only access when the official index
is damaged, and a shared per-thread lease prevents main and rescue windows from
writing the same conversation concurrently.

The rescue service has its own `4320/4321` slots and active-port pointer, with
an independent component identity (`1.1.8备用窗口` in this release). Fresh
installations stage it from the same verified package. Existing-server main
updates never switch or restart rescue automatically; the owner must explicitly
approve the independent rescue update in its UI or run
`sudo npm run server:rescue-update`.
The updater verifies the active stable package on the inactive slot, promotes
the same verified candidate to the fixed rescue port `4321`, switches the
gateway atomically, and restores the old slots on failure. Rescue
updates are always forced: they do not wait for active rescue tasks, so those
tasks may be interrupted or lost. The candidate rescue component version must
be strictly newer than the active version.
Servers upgrading from a pre-dual-slot rescue release use the CLI command for
this first transition because the old rescue UI cannot expose the new control.

## Operations center

Administrators can open `/ops` or use the server-cog control in the main title
bar. The separate operations page combines gateway, active backend, Codex
runtime, provider coverage, current tasks, connected browsers, users, quotas,
and release state without adding another service or port. The dashboard includes
a deterministic health score, request success and latency, throughput, network
traffic, Token usage, recent activity, and per-user rankings. CPU, memory, disk,
and network samples keep bounded private history. Separate Logs, Events, and
Alerts views provide sanitized request, RPC, error, system, and warning records,
state transitions, configurable checks, recovery events, cooldown reminders,
and an encrypted HTTPS Webhook notification channel.

The operations API and document are both restricted to owners and
administrators. Snapshots omit prompts, responses, thread IDs, project files,
API keys, process environments, and raw command errors. Members cannot see host
resource or cross-account status. Token counts come from the official Codex
`thread/tokenUsage/updated` notification. Duplicate cumulative snapshots are
suppressed in memory, and only numeric deltas are persisted; thread IDs remain
memory-only and bounded. Per-user views keep a durable numeric lifetime total
and expose lifetime, seven-day, and current-day usage separately from quota
windows. The page reports `Codex 未上报` instead of estimating usage or parsing
conversation files when a completed turn has no runtime usage data.
The Deployment view also has a first-run checklist for browser password,
Codex/API authorization, browser access, and the read-only update source. It
shows redacted state and links or copyable SSH commands; it never accepts a
Deploy Key or performs root network changes in the browser.

Owners also have an encrypted data-backup view in `/ops#backups`. It supports
manual or daily/weekly backups, bounded retention, verification, download, and
same-machine restore with exact backup-ID and password confirmation. Backup
archives use AES-256-GCM and SHA-256 verification. Recovery keys must be stored
separately; administrators and members cannot read or operate server backups.

## License

WFL Codex Web Workspace code is licensed under the MIT License; see [LICENSE](LICENSE)
and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The android/ SyncVault
client and tools/wfl-codex-drive/ Android client are separate components with
their own BSD-3-Clause and GPL-3.0 licenses. Fonts and dependencies retain the
licenses listed in the notices file.

## Local development

For local development outside the guided server installer, install the official
Codex CLI before setting up this interface. The official
installer for Linux and macOS is:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

The official npm package is also supported with `npm run codex:install`. Install
and sign in as the account that runs the backend service (`root` in the bundled
unit), then verify that both the CLI and its app-server surface are available:

```bash
npm run setup:check
```

The web application is not a replacement Codex runtime. Daily application
releases never install or upgrade Codex automatically; they fail before tests
or deployment if the official CLI or `app-server` is missing.

After setup, **Version Center -> Check and update** runs the official
`codex update` command in an independent background worker. If the installed
version changes, the updated app-server starts on the inactive backend and must
list real threads successfully before traffic switches. Start the update only
while no Codex task is running. The current backend remains active if the
updater or candidate verification fails. Check server-side progress with
`npm run codex:update:status`.

```bash
npm install
npx playwright install chromium
npm start
```

Open `http://127.0.0.1:4317`.

## Fresh server installation

The supported installer targets a clean Debian or Ubuntu server with systemd.
It accepts either a clean tagged Git checkout or the generated `.tar.gz`
release package with its matching `.sha256` file. Do not put a GitHub token in
a clone URL or shell history. The bundled services run as `root` so that Codex
tools and browser-triggered systemd updates work; use a dedicated VPS or
isolated server, not a host shared with unrelated production workloads.

Chinese instructions: [docs/server-deployment.zh-CN.md](docs/server-deployment.zh-CN.md).

```bash
sudo -i
apt-get update && apt-get install -y git ca-certificates
git clone --branch stable https://github.com/2296199707/wfl-codex-desktop-public.git /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
sudo bash install.sh
```

For an already downloaded package, upload both generated files, verify and
extract them, then run the same top-level installer. The wizard asks for the
archive/checksum paths when they are not next to the extracted directory:

```bash
sha256sum -c wfl-codex-desktop-v0.44.64.tar.gz.sha256
sudo tar -xzf wfl-codex-desktop-v0.44.64.tar.gz -C /srv
sudo mv /srv/wfl-codex-desktop-v0.44.64 /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
sudo bash install.sh
```

On an interactive terminal, that is the only installation command. The wizard
detects the source, offers optional version-center updates through a read-only
SSH remote, guides Codex device login and web-password creation, shows a final
plan for confirmation, and then asks how the browser will reach the service.
The three access modes are an existing HTTPS domain, a Cloudflare Tunnel, or
local/SSH-forwarded access with no public network changes.

For an existing domain, the wizard can preserve an existing reverse proxy or
install a dedicated Nginx site and obtain HTTPS through Certbot. It refuses to
overwrite a conflicting site. For Cloudflare, it guides the dashboard setup,
reads the connector token without echo, stores it only in the root-owned
`0600` `/etc/cloudflared/token` file, and starts the connector with
`--token-file`; the token is not put in project files, status metadata, shell
history, command arguments, or release packages. The Tunnel origin is always
`http://127.0.0.1:4317`.

The installer is safe to rerun and skips APT when its prerequisites are already
ready. It installs the official Codex CLI from OpenAI's installer endpoint,
with a bounded download and an automatic official npm-package fallback; then
it installs locked npm dependencies and Chromium and starts device authorization
when this machine is not logged in; creates the initial web password; renders
systemd units for the actual checkout path; and runs the same tested backup and
blue-green deployment used by normal releases. On a fresh server it then
initializes both rescue slots from the verified active release and keeps the
rescue entry on `4321`; rerunning an existing installation prepares only the
main site and preserves the frozen rescue component. Record the generated web
password when it is shown. A release worker continues if the SSH window closes,
and `npm run release:status` reports its server-side progress.

Use these commands to inspect a prepared or running host:

```bash
npm run server:check   # prerequisites, authorization status, password, and release state
npm run server:doctor  # running gateway, backend, thread/list, and bind address
```

The units bind only to loopback; do not open ports `4317` through `4321`
in the public firewall. Post-install settings have dedicated guided commands:

```bash
sudo npm run server:access    # domain, Cloudflare Tunnel, or local/SSH access
sudo npm run server:password  # single-user web password; multi-user owners use /#account
sudo npm run server:updates   # independent read-only Deploy Key and Git origin
```

The access wizard can also be opened with `sudo bash install.sh --configure-access`.
Automation can retain the original flags and add `--non-interactive`; without
an explicit access mode it safely selects local-only access. If Codex is not
already authorized, it must also explicitly opt into deferred authorization:

```bash
sudo bash install.sh --non-interactive --skip-codex-login
```

Selecting local mode does not silently remove a previously configured public
proxy or Tunnel.

The installer deliberately does not copy `.codex-desktop`, `.codex-runtime`,
`~/.codex`, provider keys, login tokens, conversations, uploaded files, or
project directories from another server. Authorize Codex independently on the
new server. Transfer projects and conversation state separately only after
reviewing their permissions and secrets.

## Password protection

Generate a strong password and store only its scrypt hash:

```bash
npm run set-password
```

Restart the server after changing the password. The browser will show its
native username/password prompt. The default username is `codex`.

Password protection does not encrypt plain HTTP. Keep the server bound to
loopback and use an HTTPS reverse proxy or authenticated tunnel for access over
an untrusted network.

## Multi-user workspace

Multi-user mode is **disabled by default** and preserves the existing single-user
layout. An owner opens the dedicated `/users` page from Settings and enables it
after re-entering the current web
password. New accounts require a one-time, expiring invitation; public
registration is never opened. Owners can invite administrators or members,
define the default member permissions and provider, and maintain reusable user
tiers. A tier applies storage, rolling Token limits, permissions, and an
optional owner provider together. Invitations snapshot their selected settings,
so later tier edits do not silently change an unregistered account.

The same page manages roles, account status, storage, custom-provider and
project-sharing permissions, provider assignment, and Token limits for a rolling
five-hour window, the UTC week starting Monday, and the UTC calendar month.
Usage history is displayed independently as lifetime, the latest seven UTC
calendar days, and the current UTC day, so an expired quota window does not
look like erased history.
Administrator-assigned providers are tracked separately from personal profiles
and can be explicitly unassigned to restore the user's previous Codex provider.
Provider profiles referenced by defaults, tiers, valid invitations, or assigned
users cannot be deleted until those references are removed.
Limits use only official Codex-reported usage. If Codex does not report usage,
the UI shows it as unavailable and the server does not invent a count or block a
task on estimated usage.

Managed users receive a private Linux system UID/GID, a `0700` HOME, separate
`CODEX_HOME`, projects, recovery records, encrypted provider store, and Codex
Bridge. Their WebSocket sessions and Codex children are independent. Session
cookies are HttpOnly, SameSite-Strict, hashed in state, limited to seven days,
and invalidated on logout or account disable. Login and invitation endpoints
are same-origin checked and rate limited.

The backend still runs as root so its systemd update and plugin functions work.
This is OS-account isolation, not a container or network sandbox: members may
read world-readable files on the host, and an administrator can manage the
host. Use a dedicated server, keep unrelated services away from it, and do not
invite untrusted users. For stronger tenant isolation use separate VMs or
containers with separate network policy.

Application quota accounting includes the managed user's HOME. It is a soft
limit when the filesystem is not mounted with `usrquota`/`uquota`; the installer
also installs `findmnt` and `setquota` from Debian's `quota` package so a
properly configured filesystem can enforce a hard per-UID limit. Enabling quota
mount options is an administrator decision and must be tested before production.

The source release archive intentionally excludes `.codex-desktop`,
`.codex-runtime`, user homes, provider keys, conversations, and uploads. A
source update is not a multi-user data migration. Back up the private state and
`/srv/wfl-users` separately, encrypt those backups, and preserve system UID/GID
mapping when restoring; copying `users.json` alone will not recreate Linux
accounts. See [docs/MULTI-USER-SECURITY.zh-CN.md](docs/MULTI-USER-SECURITY.zh-CN.md).

For a remote server, keep the app bound to loopback and forward the port:

```bash
ssh -L 4317:127.0.0.1:4317 user@server
```

## Environment

- `HOST`: bind address, default `127.0.0.1`
- `PORT`: HTTP port, default `4317`
- `CODEX_DESKTOP_UPSTREAM_PORTS`: stable-gateway backend slots, default
  `4318,4319`
- `CODEX_DESKTOP_ACTIVE_PORT_FILE`: active backend pointer used by the gateway
- `CODEX_DESKTOP_RESCUE_PORTS`: independent rescue slots, default `4320,4321`
- `CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE`: active rescue pointer used by the gateway
- `CODEX_DESKTOP_PROJECT_ROOT`: project parent directory, default `/srv`
- `CODEX_DESKTOP_PROJECT_ROOTS`: optional colon-separated list of project storage
  roots, for example `/srv:/www`; the first root remains the primary root and
  the project dialog can target any configured root.
- `CODEX_DESKTOP_DEFAULT_PROJECT`: initial project, default `/srv/workspace`
- `CODEX_DESKTOP_STATE_DIR`: private encrypted provider state, default
  `.codex-desktop` inside the application directory
- `CODEX_DESKTOP_SOURCE_DIR`: verified control source used by synchronized updates,
  default the directory containing `server.mjs`
- `CODEX_DESKTOP_RUNTIME_DIR`: shared blue-green deployment and release state,
  default `.codex-runtime` inside the source directory
- `CODEX_DESKTOP_RELEASE_DISABLED`: set to `1` to disable browser-triggered
  releases, such as in test or read-only environments
- `CODEX_DESKTOP_CODEX_UPDATE_DISABLED`: set to `1` to disable browser-triggered
  official Codex updates
- `CODEX_DESKTOP_CODEX_BIN`: explicit official Codex executable, default
  `codex` resolved from `PATH`
- `CODEX_DESKTOP_MULTI_USER_ROOT`: managed user HOME parent, default
  `/srv/wfl-users`
- `CODEX_DESKTOP_BACKUP_DIR`: encrypted data-backup directory, default
  `data-backups` under `CODEX_DESKTOP_RUNTIME_DIR`

Uploads are limited to 20 MB per file and stored under the selected project's
`.codex-uploads/` directory. They remain local to the server and are excluded
from this repository and generated source backups.

Project import accepts a gzip-compressed tar archive up to 256 MB. The server
rejects traversal paths, links, devices, reserved Codex directories, more than
50,000 entries, and extracted content over 2 GB. It verifies the archive and the
account quota in a private staging directory before publishing the project.

The resource explorer is restricted to the selected project. It hides Git and
Codex internal directories, skips dependency folders during searches, rejects
symbolic-link escapes, and limits text previews to 1 MB.

The generic RPC bridge is allowlisted. It does not expose arbitrary app-server
filesystem, process, plugin, account-login, or remote-control methods.

## Plugin platform

Open **Plugin Center** from the title bar to install, enable, disable, update,
or uninstall plugins from the bundled WFL catalog. Version 1 is deliberately
declarative: the server validates every manifest against implemented
capabilities and permissions. It does not download or execute arbitrary plugin
JavaScript, shell commands, or third-party packages. Installed manifests and
plugin state use `0600` permissions under `.codex-desktop/`.

The bundled **Temporary SSH Access** plugin accepts an SSH password only while
creating access. The password is not written to browser storage, server state,
process arguments, environment variables, application logs, source backups, or
API responses. The plugin first installs an Ed25519 public key with an OpenSSH
expiry time and forwarding disabled. If the server rejects public-key
authentication, it rolls back that key and starts a password-authenticated
OpenSSH ControlMaster instead. In that mode the one-time password reaches
OpenSSH only through a private Unix socket and the authenticated control
connection is actively closed on revocation or expiry.

Both modes keep a pinned host key under `.codex-runtime/plugin-data/`; public-key
mode also keeps its private key, while password mode keeps only the local
control socket. The first connection uses SSH trust on first use, so compare the
displayed host fingerprint with the server provider when that fingerprint is
available. Restarting or updating the backend can end an active password-mode
control connection early.

Revoke active access in the plugin window after deployment. Disabling or
uninstalling the plugin is blocked while an authorization remains active. The
authorization expires after 30 minutes even if explicit revocation cannot reach
the server. Administrators can inspect the non-secret records or obtain the
strict host-key-checking SSH arguments locally:

```bash
npm run plugin:ssh-access -- list
npm run plugin:ssh-access -- command ssh-0123456789abcdef
```

## API providers

Open **API Provider** in the command bar to save and activate custom endpoints.
Profiles use the OpenAI Responses protocol supported by the installed Codex
app-server. Remote Base URLs must use HTTPS; loopback services on `localhost`,
`127.0.0.1`, or `::1` may use HTTP.

The original Codex profile also provides OpenAI account management through the
official app-server protocol. Web login runs entirely in a temporary Chromium
on the server: the authenticated UI renders a continuous canvas stream and
relays native X11 input while the OAuth callback remains on the server's
`localhost:1455`. The browser runs without a DevTools automation channel so
human-verification, password, MFA, phone, and SMS-code steps remain interactive.
It runs as UID/GID 65534 in a read-only bubblewrap sandbox, permits only approved
OpenAI and identity-provider domains, allows one 15-minute session at a time,
and deletes its temporary profile on completion, cancellation, failure, or
timeout. It never opens an OpenAI page on the user's computer. Codex stores the
resulting credentials inside that user's isolated `CODEX_HOME`.

The same view can query the official account, lifetime usage, rate-limit
windows, and available rate-limit reset credits. Consuming a reset credit
requires a fresh server-side query, a short-lived one-use nonce, and the exact
confirmation phrase `确认重置`. Login IDs, OAuth URLs, reset-credit IDs,
idempotency keys, tokens, and raw provider responses are never returned to the
browser UI; typed OAuth input is relayed without application logging or
persistence.

Official login does not silently replace an active custom provider. Use
**Enable official configuration** after login to switch explicitly. In
multi-user mode, official account actions follow the existing custom-provider
permission and always operate in the current user's isolated runtime.

Saved keys are encrypted with AES-256-GCM. The encrypted store and its local
encryption key are created with `0600` permissions under the private state
directory and are excluded from source backups. A saved key is never returned
to the browser after submission. It is exposed only to the active Codex child
process through its configured environment variable. This protects backups and
accidental disclosure, but does not protect against an administrator with root
access to the running host.

The first managed activation records the existing Codex provider and model so
the original configuration can be restored from the same panel. Switching
profiles restarts the Codex app-server child process, not the web service. The
visible conversation remains in place and is resumed automatically after the
bridge reconnects. The last active thread ID and project path are kept in local
browser storage and up to 20 recent recovery records are kept in the private
server state directory. Only IDs, project paths, timestamps, and recovery
results are recorded; full message content remains in Codex's thread store.
Stop an active task before switching providers.

## Release workflow

Prepare a clean source revision on the protected development branch and push it
before creating a release candidate:

```bash
# Local development/test sync (keeps the visible/cache version on -beta).
npm run version:sync -- 0.22.0
# Before committing and pushing a formal release, regenerate exact versioned assets.
npm run version:sync -- 0.22.0 --formal
# Update CHANGELOG.md, review the changes, then commit and push them.
git add -A
git commit -m "release: v0.22.0"
git push origin main
```

On the designated primary server, enable the candidate center with
`CODEX_DESKTOP_CANDIDATE_RELEASES_ENABLED=1` in its deployment configuration,
then use **Prepare candidate** in the version center. The independent worker
runs the complete test and browser suites, creates and verifies the backup,
deploys to the inactive backend, and verifies the stable gateway. After actual
use has been confirmed, the owner must enter the full candidate ID and password
to promote it. Promotion atomically creates the annotated `vX.Y.Z` tag and
fast-forwards `stable` without force. Do not create the release tag before this
step. Failed or rejected candidates keep their evidence as terminal history and
can be discarded explicitly.

Candidate releases are disabled on ordinary servers and in rescue mode. The
tagged `npm run release` command remains available for an operator-managed
formal-release recovery path; it requires a clean checkout whose `HEAD` matches
both its tag and upstream. Closing the shell or browser does not stop a release
worker. Check progress at any time with `npm run release:status`.

Use `npm run release:wait` when deploying from SSH and you want phase changes
printed until completion. The release still runs in the independent systemd
worker if that waiting shell disconnects.

Servers on the remote-update capable release can use `npm run app:update:check`
and `npm run app:update:wait`, or the **Sync update** control in the version
center. Each machine needs its own read-only repository credential. See
[docs/SERVER-UPDATES.md](docs/SERVER-UPDATES.md) for the one-time bootstrap,
security boundaries, task-drain behavior, and failure recovery.

The worker also installs the backend and recovery service units
atomically and reloads systemd before the final switch. Checks, backups, and
staging keep the active backend running until the candidate is ready. Stop-first
activation directly replaces the old slot by default, and an independent
watchdog restores the old verified slot or completes the candidate after an
interruption. Codex and
data-restore recovery must succeed before a backend can start, and a failed
worker repairs the Codex CLI before changing backend topology. Candidate mode
requires a clean `HEAD` matching its upstream commit and records its commit and
source-tree hashes; direct formal release mode additionally requires the matching
tag. An uncommitted or unpushed build cannot become the active service. It normally leaves the
public `4317` gateway running; a one-time connection-policy upgrade may restart
that gateway before final verification.

On ordinary servers the version center exposes one application action: **Sync
update**. It fetches, checks, and switches the tag referenced by `origin/stable`,
and it can rerun the same checks when the
source fast-forward succeeded but the candidate switch failed. There is no
separate browser deployment endpoint. The authenticated update API requires a
same-origin confirmation header, rejects concurrent operations, and never
sends authentication records, provider keys, prompts, or command output to the
browser. A failed final switch restores the previously verified backend, and
the drain expires within 30 seconds even if automatic recovery needs operator
attention.

Production uses `wfl-codex-desktop-gateway.service` on port `4317` and one of
the `wfl-codex-desktop-backend@.service` slots on `4318` or `4319`. The deploy
command verifies the archive checksum, stages the inactive slot, stops the old
backend, and requires the expected version plus a successful Codex
`thread/list` request before switching traffic. A failed candidate triggers
the independent recovery watchdog. The
stable gateway remains running and reconnects existing browser sockets to the
selected backend after the bounded stop-first switch.

Use `npm run deploy:prepare` to extract and link an archive without starting or
switching services. Owners can start a manual rollback from the Deployment view
in `/ops`. The switch is off by default and expires after 15 minutes; the flow
requires an exact verified local version, a one-use confirmation, and the
current owner password. It backs up and drains tasks before checking the
inactive backend. Monitoring never triggers rollback automatically. Check an
independent rollback worker with `npm run rollback:status`.

Normal backend releases do not restart the public gateway. Changes to the
gateway itself, host reboots, Cloudflare outages, and network failures can still
interrupt a connection; the browser retries those automatically. The version
control in the top-left corner compares the loaded browser, running service,
and prepared source versions, shows live release phases and the release log,
and reloads browser assets only after explicit confirmation when a newly
deployed version is available.

Release packages are written under `backups/` with a SHA-256 checksum and an
internal manifest binding the package version, state compatibility, and release
commit. They omit
authentication records, deployment runtime state, dependencies, Git metadata,
logs, and environment files. The fresh-server installer restores dependencies
after verifying the external checksum and internal manifest.
