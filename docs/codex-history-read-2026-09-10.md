# Paginated history deprecation popup

## Finding and scope

The reported 0.44.80-beta popup exactly matches
`PAGINATED_THREAD_READ_DEPRECATION_SUMMARY` in local official Codex source:
`/www/mobile-agent-tooling/openai-codex-source/codex-rs/app-server/src/request_processors/thread_processor.rs`.
The `thread_read` handler emits it after a successful read with
`includeTurns: true` when `thread.historyMode` is `paginated`. It is a
deprecation notification, not a failed generation. The website currently shows
all `deprecationNotice` notifications as a toast.

The frontend's ordinary history reads already request metadata and turn pages.
Internal callers still requesting full history include retry deduplication,
active/terminal turn reconciliation, handoff, exports, and imported transcript
merging. Fix the common main-site read boundary rather than hiding notices or
changing all callers to empty histories. Existing dirty-worktree edits belong
to earlier work and must be preserved. No deployment or frozen rescue changes.

## Official sources reviewed

- https://developers.openai.com/codex/app-server/ (fetched 2026-09-10):
  metadata-only `thread/read`, turn pagination with `nextCursor`, and
  `itemsView` controlling the returned item detail. The public page does not
  fully describe the newer deprecation behavior; the local source establishes it.
- `thread_processor.rs`, `thread_read` and
  `paginated_thread_turns_list_response`: `itemsView: full` remains an explicitly
  supported compatibility path, assembling complete items for each returned
  turn. It does not emit the full-thread read deprecation notice.
- `app-server-protocol/src/protocol/v2/thread.rs`: `historyMode`, ascending
  turn-page ordering and cursor fields.

## Implemented

Added `lib/codex-thread-history.mjs` at the main-site `CodexBridge.request`
boundary for existing `thread/read(includeTurns:true)`:
read metadata first; for paginated history, assemble all ascending full-item turn
pages; for legacy/older histories retain the original full read. Preserve the
caller response shape, request deadline, native errors, request fencing, and
bridge-process identity between pages. Never return a partial history as a
successful full snapshot. Do not change browser warning handling, submission
policy, interrupt behavior or rescue-mode reads.

Legacy full reads now incur an additional metadata request. Paginated reads
share the caller's existing total deadline; no new per-page timeout extension
is introduced. This assembles history across pages, not an atomic snapshot
against concurrent writes. Native process identity and fencing are checked
between requests.

## Validation completed

- `node --test test/codex-thread-history.test.mjs test/turn-start-deduplicator.test.mjs`:
  17/17 passed. Covers complete multi-page items, deduplication, legacy fallback,
  malformed/repeated pages, total deadline, native error observation, process
  replacement/fencing and rescue-mode bypass.
- `node --test test/codex-current-conversation.test.mjs`: 1/1 passed using installed
  Codex 0.153.4, an isolated website instance and a local fake Responses provider.
  Verified tool output/history, active history reads, another thread, steering,
  interruption and resume; no full-history deprecation notifications.
- The first native fixture run exposed a separate `excludeTurns` resume
  deprecation. The real frontend already supplies `excludeTurns: true`; aligned
  the fixture with that existing behavior rather than changing production resume.
- Syntax checks and targeted whitespace checks passed. No full repository or
  browser suite was run.

Source reference commit: `6478a751fde8884b2fdc76486fe23175a8e795d4`.
The repair was initially local only. On 2026-09-11 the owner requested a local
commit and deployment, without a push. Release preparation uses 0.44.81-beta,
based on the live 0.44.80-beta source commit
`30511fb50ff7f3379d4966076f04a5b60bd8ba8b` in an isolated worktree. This preserves
the live rollback implementation, which differs from the original working
directory. The release diff contains only this repair, focused tests, this
record and normal version/cache metadata. Unrelated working files are retained.

Deploy using the existing local-candidate package and release.mjs blue-green
worker, with forced activation, independent watchdog and readiness checks.
Deployment completion will be recorded after verification. No rescue service,
assets, selector, port, or component version changes are authorized.
