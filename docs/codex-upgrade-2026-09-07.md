# Codex upgrade / GPT-6 compatibility — 2026-09-07

## Confirmed state and progress

- Initial website: 0.44.77-beta, slot 4318. Initial Codex: 0.149.0.
- Current website: 0.44.78-beta, slot 4318. Codex: 0.153.4, owner keep decision completed.
- Configured target: gpt-6-astra, managed provider. Do not substitute another model.
- Official model page confirms Responses, streaming/function calls and low/medium/high/xhigh/max reasoning: https://developers.openai.com/api/docs/models/gpt-6-astra
- Website upgrade failure: active release has a 12-character source-commit suffix, previously rejected without candidate-commit env. Local deploy.mjs fix and two focused preflight tests passed, including live preflight against slot 4318.
- Two attempts from source directory failed BEFORE invoking codex update. Source had stale ignored .codex-package.json; synchronizing metadata did not and cannot make it the active verified release. Do not retry update-codex.mjs from source or bypass this check.
- Previous broad log searches hit fixtures/mobile caches, not evidence of the model failure. GPT-6 error root cause still unconfirmed.

## Next actions

### Verified after deployment

- 0.44.78-beta published successfully using local candidate 072c83e967c2b846ef720bc5468c9615f1acd3a7 and blue-green workflow.
- Official update unit wfl-codex-update-1788799140844-970552b6 completed: 0.149.0 -> 0.153.4. Current active backend 4318 reports website 0.44.78-beta, CLI 0.153.4, threadListReady/runtimeBundleReady/codeModeHostReady true.
- Owner requested continued adaptation; the existing keep-decision workflow completed in unit wfl-codex-update-decision-1788805072795-6d51f2d5. Do not repeat the CLI upgrade or keep decision.
- New CLI model/list recognizes gpt-6-astra, including low/medium/high/xhigh/max/ultra efforts.
- Protocol method comparison: no removed methods, no critical issues or reported limitations; 5 new client requests and 6 new server notifications. This is not full schema/behavior compatibility certification.
- Same configured provider streamed a bounded GPT-6 request successfully: HTTP 200, completed, OK, 26 tokens total, 21677 ms. This was a provider-tool request, not a full website conversation test.
- Old runtime logs show unknown-model fallback plus repeated stream closure before response.completed. Model metadata problem is addressed by upgrade; long-conversation streaming cause remains unverified.
- Effort review complete: codex-policy and the model picker already support ultra. The fixed effort list in normalizeClaudeBackgroundOptions is for Claude, not Codex; do not change it. Public Responses does not use Codex's ultra collaboration setting.
- Implementation and focused verification complete; pending new website release 0.44.79-beta. Actions 1 and 2 below are complete.

1. Publish preflight fix as new 0.44.78-beta via existing local candidate/blue-green release workflow.
2. Invoke official updater from new active verified release with shared state/runtime paths; verify offline recovery and candidate health.
3. Inspect actual GPT-6 error, compare new runtime model capabilities/protocol with website; apply only evidenced compatibility changes and focused tests.
4. Record actual versions, tests and completion here. Do not claim end-to-end model success without a successful request.

## 0.153.4 schema review and implementation checkpoint

- Generated old/new schemas are in /tmp/wfl-codex-0153-review-IKOkDn/{old,new}. Old generation used the retained immutable 0.149.0 binary, new generation used installed 0.153.4.
- No required-field changes to thread/start, thread/resume, turn/start, turn/steer or turn/interrupt. thread/settings/update is unchanged. Do not replace it with turn/settings/update: the latter requires a currently running turn and has different semantics.
- Requests: 153 -> 158. Newly reviewed/deferred: MCP event stream start/stop (no existing subscriber), plugin/reconcile (native installation lifecycle), thread/timeline/list (existing paginated history remains), turn/settings/update (keep existing future-thread settings behavior).
- Notifications: 77 -> 83. Implement sanitized read-only modelProvider/authRecoveryStarted and authRecoveryCompleted. Defer MCP event stream notification and three realtime item notifications with their unused feature families.
- Confirmed gaps: SubAgentActivityKind.completed falls back to running; four new collaboration tool names fall back to a generic label; functionCallOutput has only unknown-item rendering; Guardian writeStdin action loses its details; provider auth recovery has only generic unknown-event rendering.
- New rateLimitExceeded is already recognized by provider-failure.mjs. Add regression coverage, do not change retry policy.
- New agentMessage.questions must not disappear when text is empty; display question text/options through the existing message surface, with replies still using the normal composer.
- Complete: narrow presentation/notification fixes, regenerated 0.153.4 protocol fixtures, package fixture asset list, CLI installation defaults. Conversation admission, retry, interruption, recovery, and subagent orchestration policies remain unchanged.

### 2026-09-08 verification checkpoint

- Resumed after the owner's separate Clash direct-routing request. That change is only in /root/WFL-GPT-Clash-Verge.yaml, not in the website release.
- Implementation and regenerated fixtures complete. Focused protocol, notification, transcript and UI-function checks: 96 passed, 1 skipped (optional retained 0.146 binary probe). No full repository or browser suite was run.
- Real installed-Codex / isolated website test is in test/codex-current-conversation.test.mjs. Initial failures were test-harness assumptions: bridge status uses payload.status, notifications use codex/notification, and GPT-6 uses Responses Lite.
- Official source confirmation: /www/mobile-agent-tooling/openai-codex-source/codex-rs/core/src/client.rs, build_responses_request (around line 936), places tools inside input items of type additional_tools when model_info.use_responses_lite is true; it intentionally omits top-level tools. Keep this behavior native; do not rewrite the provider request in WFL.
- The same model uses Code Mode exec, which requires the complete native code-mode-host bundle. The real installed-Codex website fixture passed in 5.4 seconds: one harmless local printf, tool output round-trip, completed reply and history read, another active turn, separate thread creation/read, steer, interrupt, and resume. The provider is local and deterministic; this does not certify a paid provider's Responses Lite implementation or long tasks.
- Additional policy and compatibility UI checks passed. One pre-existing server-install.test.mjs:197 static assertion failed: it expects the old path.join(path.dirname(projectDir), "workspace") expression in install-service-units.mjs. Neither that installer nor that test has changed in this patch; recorded rather than broadening this compatibility release.
- Deferred notifications remain on the bounded redacted unknown-event path, even after being added to the reviewed inventory; tests cover this so new MCP/realtime events do not silently become trusted raw payloads.
- Rescue baseline before deployment: service wfl-codex-desktop-rescue@4321 active, PID 768307, active since 2026-08-25 15:58:47 UTC. The main runtime has no rescue-active-port selector; do not create one.
- Next: synchronize 0.44.79-beta assets, package via package-local-candidate.mjs, deploy via existing release.mjs --package-source with the returned local candidate commit, verify main readiness and unchanged rescue process. No push requested.
- Final review preserved the old parent-turn fallback for historical started/interacted subagent activities; only explicit completed/interrupted kinds override it. Added UI-function assertions to prevent old completed tasks from appearing running again. Initial unactivated candidate f1ac8b92dd15 is superseded and must not be deployed.

## Boundaries

- No rescue component/version/slot/service updates (4321 frozen).
- No SSH or administrator conversation access changes.
- No full repository/browser suites; bounded focused checks only.
- Do not rewrite immutable active release files or relabel a different tree as an existing release.
