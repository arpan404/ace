# Cold start, thread state and readiness verification

Branch: `fix/cold-start-state`. Baseline: main `cf1234089`. Measured on 2026-10-09, darwin-arm64, Node 24.21.0.

## Real-data inspection and synthetic workload

Read the two owner audits and their saved screenshots/logs. History inspection was read-only, restricted to allowlisted transcript locations and aggregate record types/lengths. No credential files, credential key names, provider prompts, recorder, personal browser, installed app or real projects were accessed. No writes were made to `~/.ace-next`, and no real transcript contents were copied into fixtures.

| History                 |   Files measured |    Total bytes |  Largest file | Largest line |
| ----------------------- | ---------------: | -------------: | ------------: | -----------: |
| Claude projects         |              643 |  1,918,455,548 |   154,944,123 |    1,519,447 |
| Codex sessions          |            5,104 | 27,257,858,899 | 1,876,966,062 |   12,475,070 |
| Codex archives          |              248 |  3,947,953,043 | 1,366,830,869 |   11,083,123 |
| OpenCode legacy storage | 3,799 JSON files |     81,442,793 |    15,583,308 |            — |
| Pi sessions             |               53 |     36,732,433 |     2,991,068 |            — |

Claude median file: 820,646 bytes; Codex median: 960,479.5 bytes; OpenCode median: 224 bytes. The earlier audit counted about 6,000 OpenCode session headers; the fixture uses 6,000 even though the current allowlisted legacy directory contains fewer JSON files.

`apps/daemon/bench/cold-history-fixture.ts` generates invented content: 6,000 OpenCode session headers, their messages and text parts, the exact 15,583,308-byte oversized legacy record, and exact maximum-sized Codex/Claude transcripts with their measured maximum record sizes. Transcript output uses 64 KiB chunks. Unknown fields, tool output and attachment envelopes are retained in the fixture shapes. The fixture does not duplicate the owner's entire 33+ GB history volume or every content variant.

The process test uses the public history service with its existing worker limit: all 6,002 sessions are indexed, the oversized legacy record is reported/skipped, the last OpenCode session and both large-transcript prompts remain searchable, and a cached scan reads no files. This reproduces count and maximum-size pressure, but did not reproduce the audit's worker OOM; it is not evidence that the separate history OOM finding is fixed.

## Memory

Both release CLI bundles used the same generated history, isolated temporary ace homes, no configured model instances, no provider CLIs and no forced GC. Values are process-wide RSS, including workers. The baseline bundle was built from main `cf1234089`; the final bundle was built from this branch.

| Release CLI | Startup publication | RSS at 10 s (history worker active) | RSS at 60 s (history worker retired) |
| ----------- | ------------------: | ----------------------------------: | -----------------------------------: |
| Before      |              401 ms |                          266.67 MiB |                           217.67 MiB |
| After       |              443 ms |                          266.63 MiB |                           226.61 MiB |

Steady idle meets the 256 MiB budget, with 29.39 MiB headroom. Startup scan RSS exceeds that value in both versions; this is active background indexing. The shared host and allocator make a single RSS sample noisy; these are measured values, not a claim of a memory improvement. A separate exploratory source-mode Node 24 run without the large history measured 301.17 MiB at 60 s. Source-mode memory remains above budget and has not been fixed by this task.

Raw measurements: `/tmp/ace-orch/cold-start-memory-main-history.json` and `/tmp/ace-orch/cold-start-memory-after-history.json`. Reproduce with Node 24:

```sh
node apps/daemon/bench/measure.ts --idle-only --idle-ms=60000 --history-instances=/tmp/ace-orch/cold-history-instances.json --entry=/tmp/ace-orch/cold-daemon-after/ace.mjs --output=/tmp/ace-orch/cold-start-memory-after-history.json
```

The benchmark's new optional `--history-instances` file is parsed by the existing history-instance boundary. It changes only benchmark setup, not the wire protocol.

## Behavior and design decisions

- Start model discovery after default instance admission. Reuse existing catalog change pushes. Missing initial provider catalogs remain unknown; a successfully loaded catalog can still report a removed model.
- Forward subscribed `catalog.changed` frames through the shared client worker even though they carry a request id. Keep `stale` in Skills/slash state and subscribe when the composer becomes ready, so the first slash uses a warm catalog.
- Deduplicate queued displays by command identity, with uncertainty taking precedence. Separate sends with identical content remain separate. Native history replay is deduplicated by provider message identity/ordinal, never by prose.
- Recover only the latest failed message with no submission or acknowledgment and a known pre-delivery failure. Keep its exact input/references, hold it for a person, and let the existing organizer remove old settlement. Removed, superseded, submitted and uncertain inputs are not replayed.
- A restart continuation requires a recorded turn. An initial wake is not an interrupted turn.
- OpenCode/Pi readiness uses any working service, including local/free routes. A failing source cannot turn off a working one. Configured connections without a model list do not ask an already connected person to sign in.
- Hide old bookkeeping, system schemas and native replay rows at render time. Raw history is preserved. The OpenCode adapter already excludes these records; a positive/negative behavior test now guards that boundary.
- Pi reports its native permission policy without waiting for adapter admission. Pi has no selectable native permission modes, so its provider default remains usable.
- Provider changes clear stale discovered-skill details. Shared free-marker logic prevents a second Free label. Ollama Cloud uses the approved Ollama mark.

No wire/schema changes. Projection adds a direct Zod dependency for validating legacy raw metadata. No budget was raised; unused shimmer CSS was removed and no CSS rules were added.

## Validation

Every Vitest file was invoked separately with `--maxWorkers=4`; no full suite or root check was run. The worker push regression also failed with the old filter (`[]` instead of `tdd`) and passed after restoring the fix.

- `packages/client-worker/src/catalog-push.test.ts`: open subscriber receives completed discovery.
- `apps/web/src/features/skills/cold-start.test.tsx`: loading/discovery without reload, cold slash completion, warm first slash, provider-switch detail cleanup.
- `apps/daemon/src/default-models.process.test.ts`: automatic startup discovery, persisted cache, hung probe responsiveness/shutdown.
- `apps/daemon/src/engine/cold-state.process.test.ts`: recover exact unsent input and clear old settlement, no false continuation, preserve separate equal-text sends.
- `apps/web/src/features/thread/cold-state.test.tsx`: hide legacy/replayed rows, name unsent message, Activity Needs you, untouched thread, identity deduplication, preserve separate equal-text inputs, unknown model catalog.
- `apps/web/src/features/settings/cold-readiness.test.tsx`: working OpenCode source, usable Pi permissions, Ollama mark, one Free marker, working Usage account.
- `packages/ui-core/src/provider-readiness.test.ts`: sign-in/readiness rules, working local source despite another failure, no sign-in for configured/signed-in empty catalogs.
- `packages/provider-kit/src/discovery/parsers.test.ts`: configured-service copy and native CLI status parsing.
- `apps/daemon/src/engine/provider-permissions.process.test.ts`: Pi permission metadata before adapter registration and existing provider permissions.
- `packages/adapter-opencode/src/history-replies.test.ts`: reject bookkeeping/system records while continuing to emit normal answers.
- `apps/daemon/src/cold-history.process.test.ts`: owner-sized cold/cached scans and searchable last session.
- Existing `model-unavailable.test.tsx`, `opencode-free-models.test.tsx`, `queue-recovery.process.test.ts`, `restart-origin.process.test.ts` and `models.server.process.test.ts`: kept-message retry/model replacement, free labels, uncertain recovery, actual interrupted-turn continuation, background model pushes to multiple sockets.

Formatting, lint, root typecheck (once), touched-package typechecks, size, UI and dependency checks passed. Dependency-cruiser reports its existing TypeScript 7 compatibility warning. UI checks have existing pixel-value advisories, with no new baseline violations.

Bundle budgets were measured with the shared host load below 15. Gzipped sizes are recorded in `/tmp/ace-orch/cold-bundle-final.txt`; initial JS, CSS, thread/settings routes and client workers are all below their unchanged budgets. Full performance/suite checks remain for the orchestrator at merge.

## Screenshots

108 fake-daemon captures: 17 views in light/dark at 1440/390; four representative views in midnight, graphite, paper, slate and contrast at both widths. Inspected all captures through contact sheets and enlarged targeted views; retook provider/account rows after readiness and Skills details after content loading. No personal browser or live ace home was used.

Directory: `/tmp/ace-orch/shots/fix-cold-start-state/`. Exact file list: `manifest.md` there and the PR description. The `tools/web-e2e/src/cold-start-state-shots.ts` driver can reproduce the tour against a fake Vite server; `ACE_COLD_STATE_URL` changes its endpoint and `ACE_COLD_STATE_ROUTES` optionally limits a retake.
