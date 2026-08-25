# Conversation diagnostics

> Historical investigation tools only. Their ACK/checkpoint, event-log,
> canonical projection, shadow recorder, and submission-ledger reference models
> were not adopted. Current production architecture is defined by
> [`ADR-0002`](../../docs/adr/0002-app-server-conversation-authority.zh-CN.md).

These tools support the `0.39.48` conversation investigation. They are not part
of the production request path and must not be added to formal installation or
update checks.

Hard boundaries:

- They never connect to the frozen rescue window on port `4321`.
- The passive production WebSocket capture probe sends no application RPC.
  Reference-model probes use only their own random loopback protocol.
- Captures contain metadata and per-capture HMAC-SHA-256 digests, not
  prompt/reply text, cookies, API keys, tool output, or Diff content.
- Probe duration is bounded to ten minutes.
- Fault injection is an offline NDJSON transformation. It does not restart or
  disconnect production services.

## Investigation package audit

`probe-investigation-package-audit.mjs` performs a read-only completion audit of the
investigation artifacts:

```bash
node scripts/conversation-diagnostics/probe-investigation-package-audit.mjs
```

It checks the frozen source/Codex/worktree baseline, all 56 traceability rows,
contiguous M/C/S/R/G matrix IDs, status counts, Markdown tables/links/fences,
UTF-8 and whitespace, diagnostic documentation, and formal install/update
exclusion. It also statically requires ordinary update checks to remain
bounded and verifies that the main update path no longer requests rescue
readiness. Its result envelope always reports `productionRequests`,
`frozenRescuePortTouched`, and `productionRecorderActivated`; the auditor
itself performs no network or service request.

## WebSocket lifecycle

Use an existing authenticated cookie stored in a mode-`0600` file:

```bash
node scripts/conversation-diagnostics/probe-websocket-lifecycle.mjs \
  --url wss://example.test/ws \
  --cookie-file /path/to/private-cookie \
  --duration-ms 60000 > /tmp/wfl-ws-trace.ndjson
```

The probe records open, message, ping, pong, close, and error metadata. It does
not send `client/state`, `thread/resume`, or any other JSON-RPC request.
By default it creates an in-memory digest key that disappears at exit. To
compare payload equality across two layers, pass the same mode-`0600` key file
to both recorders with `--digest-key-file`; delete that key with the trace.

## Browser reconnect reference model

`probe-browser-reconnect-reference.mjs` starts a minimal replay service on a
random loopback port and connects a blank headless-Chromium page:

```bash
node scripts/conversation-diagnostics/probe-browser-reconnect-reference.mjs
```

It verifies the target transport protocol with real browser WebSocket task
scheduling:

- deliberate offline retires the old generation before sending legal
  application close code `4001`;
- ten concurrent online triggers share one connection attempt;
- stale-generation frames cannot update canonical state;
- server close code `1012` creates one replacement generation in the same
  document/window lease;
- continuous reconnect and a retained cursor gap use range replay without
  `thread/resume`, calibration, or a full bootstrap;
- event-log generation/Runtime Epoch changes start calibration;
- a calibration made stale by another generation change is discarded;
- events before and after the calibration fence are buffered and converge.

The page speaks only the probe-owned `hello`, `replay`, and `calibrate`
messages to the temporary loopback service. It does not load `public/app.js`,
connect to production, or implement persistent ACKs. Submission/pending-RPC
adjudication, log eviction, reload/new-window behavior, proxies, physical
mobile lifecycle, and candidate reliability remain outside its evidence.
The probe is excluded from package, install, update, deployment, and release
checks.

## Analyze traces

```bash
node scripts/conversation-diagnostics/analyze-conversation-traces.mjs \
  /tmp/app-server.ndjson /tmp/browser.ndjson
```

The analyzer reports malformed rows, sequence gaps/duplicates, item lifecycle
regressions, and event keys present at one recorded layer but absent at another.
It emits aggregate JSON only.

## Transform a trace with deterministic faults

Rules are JSON:

```json
[
  {
    "id": "drop-first-turn-completed",
    "op": "drop",
    "match": { "method": "turn/completed" },
    "nth": 1
  },
  {
    "id": "duplicate-first-item-completed",
    "op": "duplicate",
    "match": { "method": "item/completed" },
    "nth": 1,
    "copies": 2
  }
]
```

Apply them to a recorded sequence:

```bash
node scripts/conversation-diagnostics/inject-conversation-trace.mjs \
  --rules /tmp/fault-rules.json \
  --input /tmp/app-server.ndjson > /tmp/injected.ndjson
```

Supported offline operations are `drop`, `duplicate`, `delay`, `reorder-next`,
`disconnect-marker`, `restart-marker`, and `slow-consumer`. Marker operations
model lifecycle boundaries for Reducer tests; they do not act on a live process.
Only sanitized metadata traces are valid input: the injector preserves input
fields, so never pass raw App Server payloads to it.

## Evidence limits

These tools close only the low-load, reproducible part of the investigation.
They cannot replace:

- a real phone lock/background test;
- a second physical device or isolated authenticated client;
- production telemetry with server-issued connection IDs;
- integration fault points inside the future event log, submission ledger, and
  bounded queues;
- candidate-only 10,000-seed reliability tests.

## Installed App Server version contract

`probe-app-server-version-contract.mjs` freezes claims about the installed
Codex `0.146.0` binary instead of assuming that the continuously updated
official manual describes that older version exactly:

```bash
node scripts/conversation-diagnostics/probe-app-server-version-contract.mjs
```

It generates stable and `--experimental` JSON Schema bundles in a private
temporary directory, inspects them, and deletes the directory before exit. It
verifies:

- the installed version is exactly `0.146.0` by default; set
  `WFL_CODEX_CONTRACT_VERSION` only when deliberately auditing another version;
- stdio, Unix-socket, WebSocket, off, capability-token, and signed-bearer help
  surfaces are present;
- stable lifecycle methods and `item/*` / `turn/*` notifications exist;
- `thread/turns/list` and `thread/items/list` appear only in the experimental
  schema;
- `turn/start.clientUserMessageId` exists but neither `thread/start` nor
  `turn/start` defines `clientSubmissionId` or `idempotencyKey`;
- no WFL event generation/cursor fields or ACK/range-replay request exists.

The schema proves only the installed binary's protocol shape. It does not
start App Server, inspect conversations, prove runtime delivery semantics,
measure queue capacity, or encode transport maturity. The current official
manual and tagged source remain authoritative for experimental/unsupported
status and implementation behavior. The probe does not access `4321` and is
excluded from package, install, update, deployment, quick-check, and release
paths.

## Correlation envelope

`probe-correlation-envelope.mjs` is a pure offline model of the metadata-only
recording schema:

```bash
node scripts/conversation-diagnostics/probe-correlation-envelope.mjs
```

The fixed 512-scenario run emits and validates 9,216 in-memory records spanning
App Server, backend, gateway, browser transport, Store, and DOM. It models a
gateway upstream reconnect that preserves the browser connection, then a
document reload that preserves only the account-scoped client identity while
issuing new window, socket, gateway, and backend identities.

Short-lived capture connection IDs remain readable so the topology graph can
be joined. Account, client, window/checkpoint, Epoch/generation, RPC,
Thread/Turn/Item, and Submission IDs are exported only as domain-separated
HMAC-SHA-256 values. Payloads are represented only by byte length and HMAC.
The probe asserts that prompt, reply, credentials, tool output, Diff, and raw
user-scoped IDs are absent; it also proves that a missing layer, duplicate
layer sequence, or mismatched parent connection is rejected. A temporary
NDJSON/key pair is round-tripped as `0600` and removed.

This validates schema consistency and privacy boundaries only. It does not add
recording hooks to the production browser, gateway, backend, or App Server
bridge, and it is not connected to installation, update, or release checks.

## Shadow recorder lifecycle

`probe-shadow-recorder-lifecycle.mjs` executes the proposed stage-0 capture
lifecycle entirely in probe-owned system temporary directories:

```bash
node scripts/conversation-diagnostics/probe-shadow-recorder-lifecycle.mjs
```

It proves that the default-off state creates no segment, and that rescue/VNC
surfaces, wildcard scope, expired or overlong captures, non-owner
authorization, unknown components, unsafe modes, and a symlink key are rejected
before segment creation. Valid manifests and keys must be real owner-matched
`0600` files under a real `0700` directory.

The bounded model uses scaled-down segment and queue budgets to force rotation,
overflow, expiry, manifest/key mutation, and explicit revocation quickly.
Queue and capacity exhaustion drop trace records only. An injected gateway
`EIO` seals that component while the backend recorder remains active; no
business event, readiness state, or socket is changed. Browser receipts are
accepted only for the capture ID, token, authenticated target account, and
main channel; wrong tokens, cross-account, rescue, VNC, and unknown content
fields are rejected.

The production budgets and hook order are defined in
[the stage-0 recorder specification](../../docs/conversation-shadow-recorder-stage0.zh-CN.md).
This probe is a lifecycle model, not a production recorder, and is not
referenced by `package.json`, installation, update, release, or deployment
flows.

`probe-shadow-recorder-hook-map.mjs` separately pins the abstract recorder
design to the current `gateway.mjs`, `server.mjs`, `public/app.js`, and
`public/thread-state.js` source hashes:

```bash
node scripts/conversation-diagnostics/probe-shadow-recorder-hook-map.mjs
```

It verifies 31 admission, transport, App Server, Store, DOM, and pure-Reducer
anchors; confirms that reserved internal trace headers are not accepted from
the public gateway allowlist; and proves that neither production source nor
package/install/update/deploy/quick-check/release paths currently reference
the recorder. A source hash change intentionally fails the probe and requires
the hook map to be reviewed again.

This is a static pre-implementation check. It does not install hooks, start a
server/browser, read conversation state, authorize a capture, or validate
future recorder behavior. In particular, it cannot upgrade missing production
correlation evidence or physical mobile evidence to passing.

## Mobile field evidence bundle

`probe-mobile-field-evidence-bundle.mjs` validates the evidence package defined
by the
[physical-device field protocol](../../docs/conversation-mobile-field-protocol.zh-CN.md):

```bash
node scripts/conversation-diagnostics/probe-mobile-field-evidence-bundle.mjs
node scripts/conversation-diagnostics/probe-mobile-field-evidence-bundle.mjs \
  --bundle /path/to/field-bundle
```

With no `--bundle`, the probe creates a private synthetic fixture containing
11 scenarios × 3 repetitions, 33 runs, and 351 metadata-only trace rows. It
checks `0700`/`0600` paths, SHA-256 file manifests, scenario timing, required
layers, distinct device/network digests, stable-ID digests, and forbidden
content. It then proves rejection of missing owner attestation, reused device
or network identity, a missing Turn layer, reversed time, raw content, rescue
scope, missing repetition, excessive clock skew, and checksum tampering.

The fixture is always reported as `fieldEvidenceAccepted: false`. A bundle and
user-agent cannot cryptographically prove that hardware is physical; a real
run also requires the owner's explicit device/network/action attestation.
Desktop emulation, two browser contexts, or this generated fixture can never
satisfy the C02/C03/S10 field gate.

`--bundle` is read-only and requires `fixture=false`, the exact investigation
baseline, all 33 runs, complete checksums, private regular files, and the same
semantic/privacy gates. Passing validates evidence structure, not product
success; each scenario must still be classified from its recorded behavior.

## Event log reference model

`probe-event-log-reference-model.mjs` is a pure in-memory executable model for
failure-matrix cases C14-C17. It opens no socket, reads no production state, and
does not exercise the current main-site or rescue-window implementation:

```bash
node scripts/conversation-diagnostics/probe-event-log-reference-model.mjs \
  --seed 202642711 \
  --seed-runs 512
```

It verifies that the persistent account cursor remains monotonic across
upstream Epoch resets, every filtered cursor produces a full/skip/barrier
envelope, reload creates a new window lease from a compatible checkpoint seed,
and log/source/task state is atomic before broadcast. The subscription case
persists a barrier cursor under the old observation set, durably checkpoints
that fence, applies canonical calibration, activates the new set, and only then
delivers post-fence events. It also injects crashes before append, inside the
transaction, after commit, and after the first recipient, plus an oversized
non-compressible terminal event.

The default fixed run currently covers 17,700 events, 2,893 upstream Epoch
generations, and 1,505 calibration barriers. Passing proves that the proposed
protocol is internally consistent, not that production already implements it.
The future SQLite/IndexedDB implementation still needs the full 10,000-seed
candidate-only reliability matrix.

## Combined conversation fault matrix

`probe-conversation-fault-matrix.mjs` is a pure offline reference model that
composes faults instead of applying only the first matching trace rule:

```bash
node scripts/conversation-diagnostics/probe-conversation-fault-matrix.mjs
node scripts/conversation-diagnostics/probe-conversation-fault-matrix.mjs \
  --runs 10000 \
  --seed 1177634360
```

Every fixed-seed run has at least one mandatory drop, duplicate, adjacent
reorder, delay, disconnect, or restart fault; additional faults are selected
deterministically and may overlap. The model also injects App Server sequence
resets, event-log generation rebuilds, late non-terminal source events,
document reloads, stale checkpoints, old-generation ACKs, result loss, and
Provider switches while a submission is `unknown`.

The default 10,000-run batch currently covers 242,587 committed events,
26,419 detected cursor gaps, 16,149 ignored duplicate/late frames, 5,236 App
Server restarts, 762 event-log rebuilds, and 6,000 unresolved submissions.
All clients converge through replay or authoritative calibration; accepted
submission IDs execute at most once in the model, and unresolved submissions
are never replayed across Provider switches. Two complete runs produce the
same output digest.

The model deliberately reports `candidateImplementationValidated: false`.
It found and freezes two handshake requirements: an ACK from an older log
generation must be rejected and force resync, and a new document with no
checkpoint cannot assume that cursor zero is complete after the event log was
rebuilt. It does not execute the production Reducer, SQLite sidecar,
IndexedDB, WebSocket queues, or a candidate implementation, so it cannot count
as the formal 10,000-seed acceptance run.

## Submission ledger storage probe

`probe-submission-ledger-storage.mjs` is a development-machine-only executable
model for the encrypted submission ledger and short-lived outbox:

```bash
NODE_NO_WARNINGS=1 \
  node scripts/conversation-diagnostics/probe-submission-ledger-storage.mjs
```

It creates only private temporary SQLite databases using WAL,
`synchronous=FULL`, strict state/transition tables, the unique key
`(account_id, submission_id)`, AES-256-GCM outbox payloads, and
HMAC-SHA-256 payload/settings/model digests. AAD binds the account,
submission/type, thread destination, Provider, and all three digests. Reusing
one submission ID with the same frozen payload returns the existing row;
reusing it with a different payload is rejected.

The probe exercises `prepared -> sent -> unknown -> accepted -> terminal`,
prepared-only cancellation, explicit no-side-effect rejection, unavailable and
corrupt keys, key restoration, and the 24-hour hard expiry. At expiry,
`prepared` becomes `cancelled`; `sent|unknown` becomes
`unresolved-abandoned`, never `rejected` or `cancelled`. Accepted rows purge
the encrypted outbox in the same transaction; an unreadable outbox remains a
blocked `unknown` and is never automatically replayed.

Twelve child processes are killed with `SIGKILL` after state writes, outbox
purges, or commits for prepare, sent, unknown, accepted, and expiry cleanup.
Every pre-commit crash rolls back state, transition history, and payload
purge; every post-commit retry returns the existing transition. The bounded
benchmark uses 256 records with 2 KiB outboxes and 768 transactions. This
proves the proposed storage/state boundary is feasible, not that upstream
App Server execution is exactly once or that the production sidecar/ledger
already exists.

The probe never opens a socket or calls a Provider/model, never accesses the
rescue window, removes its temporary directory, and is intentionally absent
from `package.json`, install, update, deployment, and release checks.

## Canonical Reducer reference model

`probe-canonical-reducer-reference-model.mjs` is a pure in-memory model for
the normalized Thread/Turn/Item Store and the one action Reducer required by
the ADR:

```bash
node scripts/conversation-diagnostics/probe-canonical-reducer-reference-model.mjs
node scripts/conversation-diagnostics/probe-canonical-reducer-reference-model.mjs \
  --runs 4096 \
  --seed 1295004979
```

Realtime `msg_*`, replay, JSONL `response_item`, and snapshot `item_*` sources
all enter the same `dispatch()` path. Source IDs are aliases, not canonical
DOM keys. Mapping uses, in order, source identity, user
`clientSubmissionId/clientId`, exact official IDs, and a stable
Turn/role/type/persistent-ordinal projection. When more than one projection is
plausible, the model preserves a separate `ambiguousProjection` Item instead
of deleting by equal text.

The default 4,096 fixed-seed run applies 167,251 actions to 28,758 randomized
logical Items. Three source families converge to one canonical Item per logical
ordinal, while terminal monotonicity rejects late started/in-progress state.
Targeted cases also prove that two equal-content messages with different
submission IDs remain distinct, a `prepared|sent|unknown` optimistic Item
survives an unrelated full calibration, ambiguous Items survive calibration,
and fold state remains attached to the canonical key across live/snapshot ID
splits. The model performs zero text-equality identity comparisons and emits a
deterministic evidence digest.

This does not modify or execute the current production Reducer, browser DOM,
event log, or IndexedDB. It proves the proposed identity/reduction rules are
internally executable; the future shadow Reducer must run the same fixtures
against real App Server projections before any rendering switch.

## Event log storage probe

`probe-event-log-storage.mjs` is a bounded development-machine probe for the
proposed encrypted event-log sidecar:

```bash
NODE_NO_WARNINGS=1 \
  node scripts/conversation-diagnostics/probe-event-log-storage.mjs \
  --repetitions 3
```

It creates private temporary SQLite databases with WAL,
`synchronous=FULL`, strict tables, and AES-256-GCM payloads whose AAD binds the
account, log generation, cursor, source, event type, and canonical reference.
It checks decryption samples, scans for a plaintext sentinel, verifies mode
`0600`, and proves that an unavailable key rolls back without advancing the
account cursor.

The probe also spawns workers and kills them with `SIGKILL` after the event
insert, source mapping, task update, account-cursor update, and commit. The
worker rejects paths outside this probe's own system temporary directory.
Before-commit crashes must roll back all four state surfaces; after-commit
recovery must find the source and return the existing cursor.

The default one-repetition run writes 3,296 events and 26.375 MiB of input.
Three repetitions write 9,888 events and 79.125 MiB. This is deliberately
bounded and is not connected to `package.json`, install, update, release, or
deployment checks. Node's built-in SQLite API is still experimental, and the
results do not replace a production per-runtime sidecar (or a legacy
single-user Worker), multi-account scheduling, real payload distribution, or
IndexedDB checkpoint benchmark.

## IndexedDB checkpoint probe

`probe-indexeddb-checkpoint.mjs` launches only a blank loopback page in a
temporary persistent Chromium profile. It does not load the main site, App
Server, project history, gateway, or rescue window:

```bash
node scripts/conversation-diagnostics/probe-indexeddb-checkpoint.mjs
```

The probe uses `durability: "strict"` transactions for account-scoped
entities, immutable checkpoint metadata, and
`(accountId, checkpointSlotId)` durable heads. It proves that two slots in the
same account advance independently, asserts that ACK eligibility occurs only
after `transaction.oncomplete`, then injects an explicit abort, three abrupt
Worker terminations, and a Chromium renderer crash. A result may be fully
committed or fully rolled back, but never partially visible.

It also verifies account-selective cleanup, reload, a complete browser restart,
and a new document nonce on both lifecycle transitions. The bounded benchmark
writes 32 KiB, 512 KiB, and 2 MiB checkpoints using incompressible random bytes.
Each run uses a new profile and removes it at exit.

The browser may report `navigator.storage.persisted() === false`, and LevelDB
deletion/compaction may not immediately reduce physical origin usage. The
probe therefore validates logical account cleanup, not forensic erasure or
immediate disk reclamation. It does not replace mobile-browser storage
pressure, site-data eviction, production canonical Store, or multi-account
fairness tests.

## Event log worker fairness

`probe-event-log-worker-fairness.mjs` uses real Node Worker threads with
bounded, simulated transaction service times:

```bash
node scripts/conversation-diagnostics/probe-event-log-worker-fairness.mjs
```

It compares a global FIFO, account round-robin, and one executor per active
user runtime. It also models per-runtime ingress high/low/hard watermarks of
48/32/64 messages and 3/2/4 MiB. Per-account source order is always preserved;
terminal events never jump over earlier deltas from the same account.

The service delay is simulated rather than SQLite-backed. This probe proves
scheduler and non-preemption boundaries only. A candidate implementation still
needs its production sidecar implementation and candidate-environment
acceptance. The companion isolation probe below supplies a bounded pre-
implementation measurement with real child processes and SQLite.

## Event log sidecar isolation

`probe-event-log-sidecar-isolation.mjs` is a root-only development-machine
probe. It copies only its own sidecar runner into a private system temporary
directory, drops two child processes to two existing non-root UID/GID pairs,
and gives each runtime an owner-only state directory and independent SQLite
WAL database:

```bash
NODE_NO_WARNINGS=1 \
  node scripts/conversation-diagnostics/probe-event-log-sidecar-isolation.mjs
```

It rejects a cross-runtime database path, verifies `0700` state directories
and owner-matched `0600` database/WAL/SHM files, then runs three bounded
contention rounds. Runtime A receives 64 transactions of 16 × 4 KiB events
(4 MiB per round) while runtime B commits a terminal event. It also stops A
with `SIGSTOP`, kills it with `SIGKILL`, proves B remains writable in both
cases, and restarts A against the same WAL with an intact cursor and
`integrity_check=ok`.

The bounded flood intentionally observes the boolean returned by
`child.send()`. Returning `false` means the IPC channel no longer accepts
unbounded writes without queuing; the probe still drains its fixed input, but
the production parent must stop that runtime at its high watermark and wait
for send callbacks/low-water recovery instead of continuing to enqueue.

The probe uses real Node child-process IPC, filesystem credentials and SQLite
I/O, but its event rows are a reduced storage shape and it is not the
production sidecar. It does not validate encryption, submission-ledger
transactions, production Bridge pausing, multiple real managed users, cgroup
limits, a saturated physical disk, or candidate P95. Those remain
implementation-stage acceptance requirements. The probe is not connected to
`package.json`, install, update, release, or deployment checks.

## Five-layer Turn trace

`probe-five-layer-turn-trace.mjs` assigns one random trace ID to sanitized fake
App Server metadata, browser-received notifications, snapshot projections,
the browser Store, and transcript DOM keys. It exercises the already observed
Codex identity shape where a live assistant item uses `msg_*` and the running
snapshot uses `item_*`:

```bash
node scripts/conversation-diagnostics/probe-five-layer-turn-trace.mjs
```

The current baseline reports `targetMet: false` and a four-way origin matrix:

- two same-tick submit entries emit two `turn/start` requests with different
  client IDs. The current same-process backend accepts one and rejects one, so
  the duplicate attempt begins at browser transport but does not yet create a
  second Store/DOM item. The separate delivery-unknown probe proves that after
  an Epoch change with accepted history still invisible, both requests can
  reach the App Server;
- two raw delta notifications with one Item ID reach the browser unchanged.
  The Store keeps one Item and the DOM one node, but the marker text occurs
  twice inside both; this class begins in the notification stream;
- one raw/live assistant plus a running snapshot with another Item ID first
  creates two Store Items and then two DOM nodes. A terminal full snapshot
  reduces them to one; this class begins in Store snapshot merge;
- forcing `renderMessages()` twice with an unchanged one-Item Store leaves one
  DOM node and the same marker count, so the current keyed DOM reconciliation
  does not independently manufacture a duplicate.

These cases classify the first duplicate layer by IDs and counts instead of
text similarity. They do not claim every old production incident has enough
telemetry for retrospective classification.

The temporary App Server recorder writes mode-`0600` NDJSON containing methods,
IDs, types, lengths, and projection lists only. It does not record prompt or
reply text. The probe exports the module-private browser Store through an
in-memory response transform used only by its temporary Chromium context; it
does not modify the on-disk application asset or expose a production debug
API. The fixture models the identity split deterministically; the separate
real Codex recording is the evidence that this split occurs in Codex 0.146.

## Turn delivery unknown

`probe-turn-delivery-unknown.mjs` places a temporary write-after fault proxy
between an isolated Chromium page and a random-port main backend. It forwards
one `turn/start` through the fake App Server, drops only that RPC result, and
terminates the browser connection after execution. It then compares:

- same-Epoch retry with the backend's in-memory deduplicator;
- cross-Epoch retry when `thread/read(includeTurns:true)` can see the persisted
  user `clientId`;
- cross-Epoch retry when the request was accepted but that history is not yet
  visible;
- an ordinary `rpc/error` substituted after acceptance, followed by an Epoch
  change and a manual resend of the restored input;
- a page reload immediately after the result loss and before automatic retry.

```bash
node scripts/conversation-diagnostics/probe-turn-delivery-unknown.mjs
```

The current baseline reports two browser requests with one stable
`clientUserMessageId` in the three delivery-unknown retry cases. App Server
`turn/start` is invoked once in the first two and twice, producing different
Turn IDs, when history is not visible. In the ordinary-error case the browser
clears its pending request and restores the input; the manual resend uses a new
client ID and also creates a second Turn. This characterizes conditional
deduplication and error misclassification, not a durable delivery decision or
an exactly-once guarantee. The reload case sends no retry, but it also restores
neither the pending submission nor its frozen input.

The temporary persistence fixture stores only thread, Turn, Item, and client
IDs in mode-`0600` files; it stores no prompt body. The probe is excluded from
formal checks and never accesses production or port `4321`.

## New-thread delivery unknown

`probe-thread-start-delivery-unknown.mjs` drops the first successful
`thread/start` result after the fake App Server has created the empty thread:

```bash
node scripts/conversation-diagnostics/probe-thread-start-delivery-unknown.mjs
```

The same-Epoch case records two browser requests with one stable
`_wflClientThreadRequestId`, one App Server call, and one returned Thread ID.
The cross-Epoch case records no automatic retry: the original empty thread is
visible in the list and the original input is restored as an ordinary draft,
but neither is correlated to a durable submission. A manual resend uses a new
request ID and creates a second Thread before starting its first Turn.

The WFL request ID is intentionally stripped before the App Server call, which
proves it is only a local single-flight key. The temporary thread fixture and
trace contain IDs and empty summaries only, never the prompt body. The probe is
outside all formal checks and never accesses production or port `4321`.

## Steer delivery unknown

`probe-steer-delivery-unknown.mjs` starts an in-progress fake Turn, forwards one
`turn/steer`, drops its successful result after execution, and terminates the
isolated browser connection:

```bash
node scripts/conversation-diagnostics/probe-steer-delivery-unknown.mjs
```

The same-Epoch case retries with the same `clientUserMessageId` and is resolved
by the in-memory deduplicator. After a backend restart, visible persisted
history lets the new process find the Steer user Item by `clientId`. If that
history is not yet visible, the new task tracker considers the Turn idle and
rejects the retry with an ordinary 409 before another App Server Steer; the
browser restores the Steer as ordinary input, and a manual send becomes a new
`turn/start`. Reloading before retry instead loses the pending Steer and its
frozen input.

The current fixture therefore invokes App Server `turn/steer` once in every
scenario, but this is a timing-dependent rejection boundary, not durable
delivery or exactly-once execution. The temporary state files contain only
Thread, Turn, Item, and client IDs with empty content. The probe is excluded
from formal checks and never accesses production or port `4321`.

## Queued prompt and draft recovery

`probe-queued-prompt-reconnect.mjs` puts a controlled WebSocket interruption in
front of an isolated random-port main backend:

```bash
node scripts/conversation-diagnostics/probe-queued-prompt-reconnect.mjs
```

It verifies three current-baseline failure paths:

- editing text and removing an attachment after clicking during reconnect
  changes the eventual `turn/start`;
- switching projects after that click creates a new Thread and sends to the
  newly selected project;
- reloading an unsent text-and-attachment draft restores neither field and
  does not accidentally submit it.

The proxy classifies input only as original, edited, draft, or other while the
request is in memory. Output contains only booleans, counts, and destination
relationships; no prompt, attachment content, credential, or path is written.
The probe is excluded from formal checks and never accesses production or port
`4321`.

## Pending user legacy collision

`probe-pending-user-legacy-collision.mjs` holds a new `turn/start` before the
fake App Server can execute it, disconnects the isolated browser, advances the
same runtime Epoch from an unrelated Thread, and then reconnects:

```bash
node scripts/conversation-diagnostics/probe-pending-user-legacy-collision.mjs
```

The active Thread contains an older user Item without `clientId` whose text is
the same as the new submission. Before reconnect, the pending Store and DOM
node both exist. The sequence advance makes `refreshRecentTurns()` run before
the retry; text fallback clears the pending Store and DOM even though the RPC
is still outstanding and App Server execution count is zero. Releasing the
held retry later makes the authoritative Item appear.

This identifies the first incorrect layer as browser Store refresh settlement,
not transport duplication or DOM reconciliation. The proxy writes no prompt
or response content; output contains state booleans and counts only. The probe
is excluded from formal checks and never accesses production or port `4321`.

## Focused browser state probe

`probe-browser-conversation-state.mjs` creates a temporary state directory,
three empty projects, a fake App Server, and a main-site server on a random
loopback port. It verifies three-project task switching and records the exact
`turn/start` count for IME and same-tick click/Enter sequences:

```bash
node scripts/conversation-diagnostics/probe-browser-conversation-state.mjs
```

The probe is intentionally outside `npm test` and `npm run test:browser`.
It characterizes current failures and may therefore report `targetMet: false`
while still completing successfully. It never starts or contacts a gateway,
release worker, deployment worker, or rescue service.

## Browser WebSocket lifecycle

`probe-browser-websocket-lifecycle.mjs` runs real isolated Chromium against a
temporary random-port gateway and two temporary main backends. It records only
connection metadata and verifies:

- switching the selected main backend emits `starting -> ready` without
  closing the browser WebSocket;
- freezing the Chromium document across 3.8 one-second heartbeat periods does
  not close the browser WebSocket;
- Chromium offline/online records the app's actual close behavior. The current
  baseline reports `targetMet: false`: browser JavaScript cannot send reserved
  close code `1001`, so the call throws and online leaves the old and new
  sockets open together;
- a controlled gateway restart closes with
  `1012 / Gateway restarting`, after which the same page reconnects;
- a same-origin rejected WebSocket path produces a real browser `error`
  followed by close `1006`, empty reason, and `wasClean=false`. Every lifecycle
  envelope records monotonic/Unix timestamps, visibility, online state, socket
  ID, and socket role (`application`, `diagnostic-error`, or `other`);
- recovery classification records RPC methods, runtime epochs, message-list
  mutations, toasts, document initialization, and navigation entries for the
  initial selection, backend-slot switch, frozen document, offline/online, and
  gateway-restart phases. The current baseline shows that an epoch-changing
  slot switch performs a full bootstrap on the same document/socket, while the
  controlled same-epoch reconnect phases issue no conversation recovery RPC
  when the server sequence is unchanged;
- a second controlled gateway interruption advances the account event sequence
  with six notifications from an unrelated thread. The original page then
  issues one `thread/turns/list` for its active thread instead of replaying the
  missing events, which characterizes the current account-wide gap fallback;
- two reload controls distinguish the exact `已恢复上次对话` trigger. A reload
  with a valid `sessionStorage` active-thread snapshot performs one
  `thread/resume` without the toast. A separate same-origin document starts
  with no session keys but the durable `localStorage` recovery pointer,
  performs one `thread/resume`, and emits the toast exactly once. An
  epoch-changing slot switch on the existing document performs a full
  bootstrap but emits no recovery toast;
- every closed application browser socket reports its measured lifetime.

Three consecutive runs must report four opens, one error, four closes, close
codes `1006` and `1012`, both online states, complete envelope/close fields,
and `targetMet: true` for `browserFieldCoverage`. The rejected path exists only
to exercise a real browser error callback; it is not an application RPC or a
synthetic error object. The current three-run application lifetime ranges were
9,176-9,294 ms, 2,602-2,648 ms, and 524-575 ms for the three sockets that
closed during each run.

The script is a characterization probe, so a per-scenario `targetMet: false`
is evidence of a current defect rather than a probe failure.
Zero message-list mutations in the fixture's short thread do not prove that a
large production thread cannot flicker. Production reconnects also cannot be
classified per instance until `clientInstanceId`, `windowInstanceId`, document
identity, and navigation reason are present in telemetry.

```bash
node scripts/conversation-diagnostics/probe-browser-websocket-lifecycle.mjs
```

All main, gateway, and unused-channel ports and selection files are temporary.
The probe never requests the unused channel, never uses port `4321`, and does
not start, stop, inspect, or modify the frozen rescue window.

## WebSocket backpressure

`probe-websocket-backpressure.mjs` starts a temporary main backend with the
fake App Server and runs two bounded cases: direct backend WebSockets and a
temporary random-port gateway. In each case a fast client consumes normally
while a second client pauses TCP reads. The fixture emits exactly 128 frames of
64 KiB, so each case is capped at 8 MiB.

```bash
node scripts/conversation-diagnostics/probe-websocket-backpressure.mjs
```

The output records fast-client completion, paused-client drain time, and RSS
for the temporary backend/gateway processes. `targetMet: false` documents that
the current send paths have no per-client message/byte budget, callbacks, or
`bufferedAmount` telemetry. The probe does not contact production, does not
test App Server stdin saturation, and is never part of install, update,
release, or ordinary-server checks.

## App Server stdin backpressure

`probe-app-server-stdin-backpressure.mjs` starts a temporary random-port main
backend, confirms one normal read-only RPC, and sends `SIGSTOP` only to its
temporary fake App Server child. It then sends exactly 128 read-only requests
with 64 KiB of diagnostic padding, capped at 8 MiB total, and records pending
responses, backend/fake-child RSS, and `/internal/codex-ready`.

```bash
node scripts/conversation-diagnostics/probe-app-server-stdin-backpressure.mjs
```

The fake child is resumed with `SIGCONT` before cleanup. The probe never waits
for the normal 120-second RPC timeout, never signals a production process, and
is excluded from all install, update, release, and ordinary-server checks.

## Focused browser render performance

`probe-browser-render-performance.mjs` uses the same isolated random-port
environment to measure:

- opening a thread to its first recent assistant message;
- first and final streaming delta receipt to visible text;
- completion-event receipt to materialized project-file links;
- DOM size and Chromium long tasks for each phase.
- the current renderer's actual 2 MiB command-output plus 20,000-line Diff
  path, including source-to-browser timing, marker visibility, Long Tasks,
  DOM size, and the DOM remaining after both `<details>` elements are closed.

The controlled assistant response contains Markdown-like headings, emphasis,
inline code, and 320 project-file references. This distinguishes the current
plain-text assistant renderer from its special file-reference buttons. The
large-payload case is intentionally a current-failure characterization: the
command body may be hidden by the UI output preference, but the complete
payload still enters the current state/render path; the closed Diff retains
19,999 line rows and roughly 80,000 element nodes. The target requires zero
closed Diff rows and main-thread slices no longer than 8 ms.

```bash
node scripts/conversation-diagnostics/probe-browser-render-performance.mjs
```

It is a bounded characterization probe, not a pass/fail release check. It is
also intentionally outside all install, update, deployment, and package test
scripts.

## On-demand transcript renderer reference

`probe-on-demand-render-reference.mjs` does not load the main site. It builds
an isolated headless-Chromium reference renderer for the target transcript
semantics:

```bash
node scripts/conversation-diagnostics/probe-on-demand-render-reference.mjs
```

The synthetic fixture contains 80 Turns, a 20,000-line raw Diff, a 2 MiB tool
output, and 512 KiB of reasoning. It verifies:

- only the most recent eight Turns are mounted;
- closed file/tool/reasoning blocks read no body and create no detail nodes;
- Diff parsing occurs in a Worker; the main thread mounts 10-line Diff slices
  and 8 KiB text slices, with 500 Diff lines per visible page;
- closing unmounts derived DOM while retaining canonical raw content;
- live/snapshot aliases retain one canonical node, fold state, and unread key;
- 100 streaming patches do not trigger a full transcript render;
- prepending older Turns retains the same scroll-anchor node and position.

This is an executable target model, not a patch to `public/app.js`. It does
not validate production CSS, Markdown sanitization, selections, search,
accessibility, Worker crash recovery, memory pressure, physical mobile
hardware, or candidate-release performance. It starts no server, reads no
production state, never uses port `4321`, and is excluded from package,
install, update, deployment, and release checks.

## Two isolated browser clients

`probe-browser-multi-client-state.mjs` starts two separate Chromium contexts
against one temporary account runtime. It verifies:

- account-wide notifications reach a client observing another thread while its
  transcript remains isolated;
- independent contexts receive distinct session lease-owner IDs;
- two clients can observe one running thread;
- closing one client does not unload the shared thread across the default
  reconnect grace;
- the final observer keeps a completed thread loaded until it explicitly
  unsubscribes.

```bash
node scripts/conversation-diagnostics/probe-browser-multi-client-state.mjs
```

This models independent browser storage and sockets. It does not claim to
replace a physical second device, mobile lock/background behavior, or the
future durable per-device ACK cursor.

## Goal pause, provider switch, and retry classification

`probe-goal-provider-recovery.mjs` starts a temporary main-site server, fake
App Server, and two loopback model-list endpoints on random ports. It verifies:

- an after-Turn Goal pause leaves the current Turn running to natural
  completion;
- the paused Goal can switch to a second provider while idle, record the
  before/after provider audit, resume, and start exactly one new Turn with the
  second provider environment;
- a manually paused Goal remains paused after restarting only the temporary
  main-site server, without a browser;
- timeout, HTTP 429/quota, and HTTP 401/invalid-credential retry exhaustion all
  currently enter the same `provider-unavailable` recovery path.

```bash
node scripts/conversation-diagnostics/probe-goal-provider-recovery.mjs
```

The last result is a characterization failure for quota and credentials, not a
passing expectation. The probe makes no production requests, never uses port
`4321`, and is intentionally outside package, install, update, deployment, and
release checks.

## Conversation migration and rollback reference

`probe-conversation-migration-reference.mjs` turns the seven ADR migration
phases into a pure in-memory state machine:

```bash
node scripts/conversation-diagnostics/probe-conversation-migration-reference.mjs
```

It verifies:

- pre-transaction, post-draft/pre-commit, and post-commit crash boundaries for
  every phase;
- exactly-once phase recovery after commit and complete rollback before commit;
- owner, administrator, then account protocol waves, while version 1 clients
  remain on legacy broadcast and cannot ACK or advance event-log retention;
- all 120 rollback orders of renderer, ACK, submission, index, and legacy
  full-history deduplication without deleting schema, ledger, or JSONL state;
- preservation of an unresolved submission without replaying it through a
  different provider;
- four candidate-release failure boundaries that retain the old active backend
  and administrator conversation access.

This probe does not read production state, execute current release scripts,
perform a real schema or browser-bundle migration, or validate a candidate
deployment. It starts no server, does not touch or inspect rescue component
`1.0 / 4321`, and is excluded from package, install, update, deployment,
quick-check, and release paths. Ordinary-server complete suites, browser smoke
tests, and load/stress tests remain forbidden.

## Legacy history index reference model

`probe-legacy-history-index.mjs` builds a private synthetic Codex 0.146-style
JSONL file and a disposable SQLite WAL index:

```bash
node scripts/conversation-diagnostics/probe-legacy-history-index.mjs
```

The fixture is at least 50 MiB and includes a multi-megabyte line. The probe
indexes only Turn/row ordinals, byte ranges, protocol enums, and
HMAC-SHA-256 digests. It verifies:

- first scan and safe-offset incremental append;
- withholding an incomplete final line until its newline arrives;
- backward/forward Turn summary pagination without an official RPC;
- rebuilds after truncation, inode replacement, or a changed head prefix;
- UID, GID, and mode rejection without repairing the source;
- atomic rows/checkpoint recovery at real pre-commit and post-commit
  `SIGKILL` points;
- absence of a synthetic body sentinel from the SQLite sidecar.

The model assumes Codex rollout files are append-only between rebuilds. Its
head and last-indexed-anchor checks do not detect arbitrary in-place mutation
in the middle of a file. It uses Node's experimental SQLite API and does not
read production history, install a Worker/UserRuntime sidecar, call
`thread/read` or `thread/resume`, or validate the future 200+ MiB candidate.
It is intentionally excluded from package, install, update, deployment, and
release checks.
