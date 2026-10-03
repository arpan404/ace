# Cursor SDK implementation verification

This branch contains the local SDK adapter, SDK-first daemon selection,
backend/instance persistence, capabilities, bounded portable context, HTTP MCP
injection, selected-instance model discovery, auth host seam and passive SDK
recording support. It is **not ready to merge** until auth UI/lifecycle assembly and the
runtime validation below are complete. No live Cursor turn, browser login,
fixture recording, benchmark, mutation or test was executed.

The owner explicitly permits only formatting, lint, typecheck and source-size
checks before merge. Behavior tests are written for merge-time execution.

Static validation: `bun run fmt`, `bun run lint`, `bun run typecheck` and
`bun run check:size` passed. These do not establish runtime correctness.

## Written behavior tests — needs run at merge

- Account SDK auth source survives restart and quota updates, rejects key-bearing status and leaves another instance unchanged.
- SDK catalog normalization retains authenticated parameters and redacts unknown key-bearing metadata without guessing ACP defaults.
- SDK discovery admits CLI-free installation, refuses wrong versions/helpers and Windows, and distinguishes absence from broken installation.
- Backend registry selects SDK for new threads, permits ACP only on SDK absence and retains old native IDs through additive SQLite migration.
- Full/restricted policy mapping fails closed without verified Auto-review.
- Selected HOME and environment auth stay isolated; auth results discard the sentinel key and logout preserves another instance and history.
- Delta/stream/result overlap renders once; equal messages from different turns survive; unknown message/envelope data and ambiguous snapshot evidence are retained.
- Steering retains one ace run across SDK segments; old results cannot settle the replacement.
- Per-turn usage is emitted once, cumulative result usage is not added again and missing cost stays unknown.
- Denied MCP/nonzero shell tools stay failed after a successful root result, with no fabricated question or plan approval.
- Plans/todos/edit diffs map to canonical content and SDK truncation is visible.
- Foreground/background/nested tasks retain whole-tree status, late native identity and declared visibility limits; unresolved shells survive root end.
- Sign-out drains an outstanding login before deleting selected-instance credentials.
- Real synthetic Node host I/O preserves steering identity, rejects child control and awaits shutdown.
- Getter/depth/byte admission refuses unbounded arbitrary payloads before serialization; oversized checkpoint recovery refuses before full-conversation loading.
- Portable handoff stays within its budget, records source and exposes loss while retaining identical entries.
- Client controls honor sandbox-only/read-only policy while retaining legacy provider defaults.
- SDK HTTP injection rejects remote/decorated URLs and uses the bearer header through the existing MCP transport.
- Authoritative SDK auth/quota/network failures remain failures without fabricated retries.
- Literal JSON-shaped text fragments survive redaction while known secrets and structural secret fields remain scrubbed.
- SDK input is bounded before durable admission; the pending/queued/in-flight input backlog refuses excess commands.
- Host open publishes its native identity before frames, and unknown terminal status fences subsequent sends.

Existing engine restart tests cover committed input, acknowledged/pending intents
and uncertain delivery without automatic resend. Combined SDK crash-before-send,
crash-after-send, parent-death, slow-consumer, heap failure, admission/logout races
and auth UI service behavior need additional assembly tests and execution. The
written account factory test covers two homes and selected-instance fencing.

## Mutation cases — not executed (tests run at merge)

1. Accept a resolved SDK version other than 1.0.35: discovery version refusal.
2. Treat missing sandbox helpers as supported: discovery helper refusal.
3. Run restricted execution without Auto-review: policy failure assertion.
4. Reuse the launch HOME: selected-home assertion.
5. Return SDK login's apiKey: safe auth/sentinel exclusion assertion.
6. Delete the other instance or checkpoint during logout: preserved-file assertions.
7. Append both stream messages and onDelta: single rendered message assertion.
8. Deduplicate equal content from separate operations: two identical messages assertion.
9. End the logical run on steering cancellation or late result: one active run assertion.
10. Add terminal cumulative usage to per-turn counters: one usage event assertion.
11. Complete a background child on dispatch: whole-tree status assertion.
12. Treat denied MCP/nonzero shell as success: failed tool assertions.
13. Invoke getters/serialize oversize frames: admission refusal and untouched getter assertion.
14. Load checkpoint history before the disk budget gate: oversized recovery refusal.
15. Permit child interrupt/stop/question resolution: unsupported-control assertions.
16. Remove portable context byte limits: bounded handoff/truncation assertions.
17. Redact numeric token counters as secrets: safe SDK accounting assertion.
18. Overwrite a failed run with a duplicate success result: first failed outcome assertion.
19. Erase literal JSON-shaped deltas: literal streaming text assertion.
20. Remove durable input admission bounds: oversized input and queue-full command results.
21. Accept further sends after unknown terminal status: uncertain-delivery refusal.
22. Publish the open frame before native identity: frame callback checks the pinned native ID.
23. Mask SDK environment auth or inherit it into ACP: selected backend environment assertions.
24. Lose safe auth-source metadata on quota updates/restart: SQLite registry status assertions.
25. Persist a key-bearing auth status: strict auth schema refusal.
26. Stop the other selected instance or release its writer: live second-host send and migration refusal.

These are designed mutation cases, not evidence that executed mutations were killed.

## Performance — needs run at merge

`packages/adapter-cursor/bench/translate.ts` measures admitted delta translation
without accumulated transcript scans; `bench/ipc.ts` covers payload admission and
shared writer backpressure. Both report ops/s, microseconds/op and peak
RSS. **No numbers are available:** the owner prohibits benchmark execution.
Long-session identity eviction, terminal boundaries, IPC/backpressure throughput
and SDK full-conversation/native-helper RSS still need measured coverage. The SDK
can buffer internally; an old-space budget is not a total process RSS guarantee.

## To record after approval

Approved SDK fixtures: **none**. Existing ACP fixtures remain intact.
All SDK scenarios use **1.0.35**, **composer-2.5**, disposable workspaces and a fresh
isolated fixture instance. Namespace:
`fixtures/cursor-sdk/1.0.35/composer-2.5`. The passive capture sink cannot start a
turn or sign in; recorder CLI/lifecycle orchestration and fixture expectation
generation remain assembly work.

1. Text/thinking/read: streaming order, channel overlap, identities and terminal result.
2. Edit/shell success/failure: diffs, output, exit status and failed tool/root outcomes.
3. Restricted sandbox/Auto-review: safe read, denied outside operation and MCP denial without approval UI.
4. Full access: sandbox disabled and safe write/shell in a disposable workspace.
5. Plan/todos/question attempt: native plan/todos and unavailable answer/review callbacks.
6. Foreground child: call/native association, nested content and completion order.
7. Background child: dispatch versus continued work and whole-tree settlement.
8. Nested task: observed grandchildren and incomplete deeper content.
9. Background shell: observable completion or preserved uncertainty.
10. Interrupt with shell/child: cancel/result/close order and surviving work.
11. Steering restart: two SDK runs, one ace run and late old frames.
12. Close/resume/history: checkpoint identity, positional reconciliation and usage overlap.
13. Portable fork: fresh native identity, bounded provenance and preserved source.
14. Thread MCP/image: lease identity, policy result and image mapping.
15. Usage: per-turn/cumulative association and optional billed lookup.

Auth uses only stubbed SDK operations and sentinel temp stores in offline tests.
Actual browser login is a separate owner action; auth callbacks, challenge URLs,
keys and raw auth results never belong in recordings. No artificial quota-spending
rate-limit scenario is proposed.

## Departures and open integration work

- Train 2 and Claude changes are merged into this branch. Account SDK factories,
  narrow environment inheritance, CLI sign-in/status and safe auth-source storage
  are integrated. Browser login/logout socket UI and selected-instance auth lifecycle
  composition still need product integration and multi-instance execution. Generated
  protocol references for additive SDK fields need regeneration at merge.
- Restricted admission defaults to refusal. A trusted availability flag is the
  current gate; no authoritative Auto-review availability probe exists here.
  Sandbox/MCP fail-closed behavior needs the approved live scenario.
- SDK task children inherit MCP credentials without reliable caller attribution.
  The daemon grants a read-only lease to the entire SDK host, including root;
  mutating ace MCP calls remain unavailable.
- Snapshot revision/position validation refuses uncertain appends, but a complete
  live/snapshot reconciliation index and checkpoint-native run recovery are not
  implemented. Instance/native admission identities persist early; unclaimed
  checkpoint stores refuse fresh creation. ace history remains canonical;
  uncertain dispatch is never replayed.
- Raw bodies above 256 KiB fail visibly rather than streaming directly from the
  SDK callback into blobs. Admitted raw data uses the existing daemon blob owner.
- JavaScript heap/checkpoint/IPC bounds are implemented. Native/helper memory,
  mid-turn checkpoint growth, SDK-internal buffering and ancestor symlinks need
  stronger containment/measurement before claiming total bounded resources.
- Windows home/sandbox/process ownership is unsupported. POSIX parent-death and
  idle cleanup have source-level ownership guards but need execution at merge.
- Deeper nested task and background completion evidence remains incomplete.
  Late authoritative non-child tool completion across steering segments is not
  fully reconciled; unresolved work stays uncertain.
- SDK catalog parameter metadata is retained/normalized, but end-to-end selection
  of arbitrary SDK model parameters still needs a shared model-selection contract.
- Billed usage association and quota windows remain unknown, with no guessed cost.
- Client policy helpers are available; desktop/web/mobile control wiring needs
  product integration before all user surfaces expose these controls.
- SDK version churn is a refusal until explicitly accepted; separate SDK sign-in
  and environment API-key policy must remain visible. No native ACP-to-SDK
  checkpoint conversion or cross-account checkpoint copy is claimed.

Do not merge this branch without the orchestrator's instruction.
