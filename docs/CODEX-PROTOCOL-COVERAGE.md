# Codex app-server protocol coverage

The authoritative machine-readable inventory lives in
`lib/codex-protocol-coverage.mjs` and is checked by
`test/codex-protocol-coverage.test.mjs`.

Baseline: `codex-cli 0.149.0`.

The inventory classifies all 153 client request methods emitted by
`codex app-server generate-ts --experimental`. The checked-in generated method
snapshot is `test/fixtures/codex-app-server-0.149.0-client-methods.json`.
The same review covers all 11 app-server-initiated methods in
`test/fixtures/codex-app-server-0.149.0-server-methods.json`, all 77
server notifications, and the single client notification. The schema manifest
records when the reviewed snapshot was generated.

## Runtime capability matrix

WFL probes the installed app-server method surface at startup rather than
assuming that a version string guarantees an optional feature. Core chat
methods and notifications remain mandatory. Optional methods are exposed only
when the complete method group is present:

| Runtime surface | Codex 0.146 | Codex 0.147 | Codex 0.149 | WFL behavior when absent |
| --- | --- | --- | --- | --- |
| Core thread list/read/start/resume and turn start/interrupt | Available | Available | Available | Backend activation is blocked if a core method disappears |
| Persistent conversation sections and `section_position` sorting | Unavailable | Available | Available | Section controls are hidden and `thread/list` uses `updated_at/desc` |
| Unified experimental `plugin/search` | Unavailable | Available | Available | Native search is hidden; configured WFL marketplace inventory remains usable |
| Cursor/Claude external-agent migration methods | Available | Available | Available | Migration source is hidden if the detected method group is incomplete |
| Native thread queue and history-only `thread/revert` | Unavailable | Unavailable | Present | Held behind an explicit WFL handoff and recovery contract |

WFL never sends an optional RPC to a runtime whose method probe does not confirm
it. Requests that race a
runtime change fail locally with `ERR_CODEX_RUNTIME_FEATURE_UNAVAILABLE`, while
new conversation, send, list, and recovery continue through the core protocol.

Coverage states:

- `browser`: directly available to the WFL browser client.
- `internal`: used by guarded server workflows rather than exposed directly.
- `custom-equivalent`: covered by an application-owned API with equivalent
  user-visible behavior.
- `planned`: part of the active long-term implementation plan.
- `deferred`: intentionally held until the upstream experimental surface is
  stable or the lower-priority product surface is scheduled.
- `not-applicable`: platform-specific behavior that does not apply to the
  Linux server deployment.

When Codex is upgraded, regenerate its JSON schema, compare `ClientRequest`
methods with the inventory, classify every new method, and add a regression
before releasing the application update. Unknown methods must never be
automatically exposed to the browser.

## Server-initiated request boundary

Only modern command approval, file-change approval, structured user input,
permission approval, and MCP elicitation requests can be routed to a browser.
Their payloads pass through a bounded JSON clone, while MCP URL elicitation
continues to replace the authorization URL with an opaque isolated-browser
snapshot.

Command prompts preserve the upstream `approvalId` callback identity and render
only entries from `availableDecisions`; the browser cannot invent a
session-wide decision that the app-server did not offer. Permission responses
are checked again on the server and may grant only the network, path, entry,
and scan-depth subset present in the original request. Managed-user file
requests are additionally confined to that Unix user's home and explicitly
shared projects before any path reaches the browser.

`currentTime/read` is answered inside the backend using whole Unix seconds.
Dynamic tools remain disabled by default and receive a protocol-shaped failed
tool result. Externally managed ChatGPT token refresh and client attestation are
rejected at the bridge because WFL neither selects the external-token login mode
nor opts into host attestation. Legacy approval requests are declined without
reaching the browser. Any server request absent from the reviewed inventory
receives a JSON-RPC method-not-found error.

## Managed permissions and collaboration presets

The browser reads `configRequirements/read` and the paginated
`permissionProfile/list` to show account isolation, administrator-enforced
requirements, the user's selection, and the resulting effective permission
profile separately. Disabled profiles, approval policies, approval reviewers,
sandbox modes, and web-search modes remain visible with their policy reason.
Every corresponding `config/value/write` and thread policy override is
revalidated by the server against fresh app-server requirements, and browser
callers cannot supply a config file path or a raw `sandboxPolicy`.

`collaborationMode/list` supplies the official collaboration presets. A preset
is independent from Ultra reasoning effort: the user may select Ultra without
a preset, or select an official preset whose model and effort mask takes
precedence for later turns. The server accepts only an exact currently listed
preset with `developer_instructions: null`; arbitrary browser-provided
collaboration instructions are rejected. Official Codex subagent settings remain
separate from the selected turn. WFL does not add a second task-budget,
continuation, lifecycle, role, or orchestration contract for subagents.

## Deprecated thread rollback

`thread/rollback` remains present in the `0.149.0` generated schema but is
deprecated. Codex 0.149 also adds experimental `thread/revert`, which replaces
durable conversation history with the prefix before a selected turn and does not
revert local file changes. WFL does not expose either mutating history RPC; users
retain history through `thread/fork`, managed Worktree generations, and immutable
recovery snapshots instead.

## Official Apps and Plugins gate

For the reviewed Codex CLI runtime, WFL exposes the read-only
`app/installed`, `app/list`, and `app/read` methods behind the independent
`codexApps` permission.

Codex 0.147 and later add experimental unified `plugin/search`. WFL exposes that search
only when runtime probing confirms the method and the account has the separate
`codexPlugins` permission. Native `plugin/list`, `plugin/read`, sharing, skills,
and marketplace mutation surfaces remain deferred. Installation and removal
continue through WFL's verified guarded plugin operations rather than forwarding
arbitrary browser RPCs to experimental upstream mutation methods.

## Integrated terminal boundary

The browser exposes `command/exec`, input, resize, terminate, and the
experimental per-thread background-terminal inventory behind the independent
`codexTerminal` permission. Standalone commands are forced into a
project-bounded workspace-write sandbox with network access disabled, bounded
output, bounded duration, and server-generated app-server process identifiers.
Output is routed only to the browser window that created the process, and a
disconnected window causes its processes to be terminated.

`thread/shellCommand` intentionally preserves shell syntax and is unsandboxed
upstream. WFL therefore restricts it to owners and administrators, labels it as
unsandboxed, and requires an explicit browser confirmation for every command.

## Project file watching boundary

The resource explorer uses native `fs/watch` and `fs/unwatch`, but does not pass
browser-selected identifiers or paths directly through. The server validates
the requested path against an accessible project, substitutes an internal watch
identifier, binds the subscription to one authenticated browser window, and
returns only project-relative changed paths. Closing that window unregisters
its watches, while app-server disconnects invalidate every watch so the browser
can subscribe again after reconnecting.
