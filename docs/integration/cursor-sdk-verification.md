# Cursor SDK implementation verification

This branch contains the local SDK adapter, SDK-first daemon selection,
backend/instance persistence, capabilities, bounded portable context, HTTP MCP
injection, selected-instance model discovery, auth host seam and passive SDK
recording support. Browser auth backend/protocol and durable checkpoint recovery
are now assembled; UI implementation is separately owned. The branch is ready
for static review, with runtime validation deferred to merge under owner policy. No live Cursor turn, browser login,
fixture recording, benchmark, mutation or test was executed.

The owner explicitly permits only formatting, lint, typecheck and source-size
checks before merge. Behavior tests are written for merge-time execution.

Static validation: `bun run fmt`, `bun run lint`, `bun run typecheck` and
`bun run check:size` passed (1,626 tracked sources within the hard limit). These
do not establish runtime correctness.

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

Additional continuation behavior guards (all need run at merge):

- Remote paired clients receive and poll their own browser login URL; another device is refused, and completion clears the URL.
- Login return keys stay out of socket results; credentials/challenges stay out of accounts SQLite and canonical event history.
- Sign-out cancels a browser exchange before deleting credentials; expiration clears challenges without a timed test sleep.
- Default SDK admission enters accounts ownership with its original home before thread/auth requests; configured SDK launch environment remains separate from ambient credentials.
- Selected account identity survives registry restart; thread creation pins it before asynchronous dispatch and honors an explicit override.
- Official SQLite checkpoints and native run identity survive close/reopen; existing SDK JSONL remains readable and conflicting/partial formats preserve their source.
- A real killed daemon resumes its pinned native/account identity, recovers a journal delta that missed ace's commit, skips a repeated committed delta and preserves identical messages in separate turns.
- Callback boundary offsets never become durable SDK ObserveRun offsets, including after journal recovery.
- Native queued/running records become interrupted after restart without resending input or changing already completed outcomes.
- Torn journals, torn legacy native records and cursors beyond their journal refuse recovery without truncating evidence; metadata without native conversation state requires explicit handoff.
- Oversized native checkpoint writes visibly fence further writes while retaining the previous checkpoint.
- Late failed tools settle their original call without splitting replacement text or ending the logical steering run.
- An old segment's callback/checkpoint overflow fences the shared host instead of letting replacement execution continue.

Existing engine restart tests cover committed input, acknowledged/pending intents
and uncertain delivery without automatic resend. Parent-death, slow-consumer,
heap failure and combined cancellation/admission races still need execution and
live SDK evidence at merge; static review is not runtime proof.

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

27. Expose one device's login challenge to another device: forbidden poll assertion.
28. Retain a login URL after completion/cancellation: terminal event exclusion assertions.
29. Delete credentials before the login worker exits: ordered sign-out outcomes assertion.
30. Remove login expiration: cancelled/not-found state and challenge exclusion assertions.
31. Resolve the account at async dispatch instead of command acceptance: selected/explicit account edge assertions.
32. Replay a committed journal delta again: killed-daemon transcript assertion.
33. Skip the journal delta missing from ace's commit: recovered complete text assertion.
34. Feed callback positions into SDK ObserveRun: native offset independence assertion.
35. Mark finished native runs interrupted: completed native outcome assertion.
36. Reuse a partial/conflicting native store as a fresh SQLite checkpoint: source-preservation refusal assertions.
37. Admit an oversized native checkpoint blob: prior checkpoint preservation and visible fence assertions.
38. Split replacement text on a late tool completion: one replacement message assertion.
39. Ignore shared host overflow from an old segment: failed whole-tree status assertion.

40. Substitute the current default account for an unpinned resume: refused resume assertion.

41. Re-register the original default SDK identity under a new home or bypass accounts ownership: daemon composition/pinned native home assertions.
42. Substitute ambient credentials for the configured SDK environment: synthetic host auth-source assertion.

43. Let the SDK silently drop a torn legacy JSONL record: source-preserving malformed checkpoint refusal.
44. Resume agent metadata without its native conversation checkpoint: missing native state refusal.

45. Admit a linked or oversized SDK credential store: cross-home source-preservation refusal.

46. Resolve the shared migration number as only SDK or only ACP: cold-store identity assertions for both historical shapes.

These are designed mutation cases, not evidence that executed mutations were killed.

## Performance — needs run at merge

`packages/adapter-cursor/bench/translate.ts` measures admitted delta translation
without accumulated transcript scans; `bench/ipc.ts` covers payload admission and
shared writer backpressure. `bench/checkpoints.ts` measures callback journal
fsync/replay and the public native SQLite metadata store. All report ops/s,
microseconds/op and peak RSS. **No numbers are available:** the owner prohibits benchmark execution.
Long-session identity eviction, terminal boundaries, IPC/backpressure throughput
and SDK full-conversation/native-helper RSS still need measured coverage. The SDK
can buffer internally; an old-space budget is not a total process RSS guarantee.

## To record after approval

Approved SDK fixtures: **none**. Existing ACP fixtures remain intact.
All SDK scenarios use **1.0.35**, **composer-2.5**, disposable workspaces and a fresh
isolated fixture instance. Namespace:
`fixtures/cursor-sdk/1.0.35/composer-2.5`. The passive capture sink cannot start a
turn or sign in. Actual recorder orchestration and fixture expectations will be
completed with the owner-approved recordings, without changing runtime admission.

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

## Deliberate limits and merge-time work

- Backend browser auth and selected-instance lifecycle are assembled through the
  daemon service registry. Web/desktop auth views and other client control wiring
  are separately owned. Generated protocol references need regeneration at merge;
  the owner's allowed-command list excludes documentation generation/checking.
- New SDK threads use the public transactional SQLite store. Existing SDK JSONL
  stores keep their format. Redacted callback journals commit before IPC and ace
  commits its cursor atomically with canonical facts. Pure translation hydration
  and journal replay own canonical content; native durable observations and
  positional snapshots remain bounded evidence, never text-equality guesses.
- Native active runs reconcile before continuation, and ace marks crash-live runs
  failed/interrupted with actionable uncertain-delivery notices. Input is retained
  without automatic resend. Native store cancellation cannot prove that provider
  inference or every helper stopped; explicit uncertainty remains visible.
- Restricted admission defaults to refusal. A trusted availability flag is the
  current gate; no authoritative Auto-review availability probe exists here.
  Sandbox/MCP fail-closed behavior needs the approved live scenario.
- SDK task children inherit MCP credentials without reliable caller attribution.
  The daemon grants a read-only lease to the entire SDK host, including root;
  mutating ace MCP calls remain unavailable. No privileged custom-tool bypass.
- Raw bodies above 256 KiB fail visibly rather than streaming directly from the
  SDK callback into blobs. Admitted raw data uses the existing daemon blob owner.
- Heap/checkpoint/IPC/callback limits, native write guards and ancestor-symlink
  refusal are implemented. Auth workers also reject linked/oversized credential
  stores before SDK import without reading their contents. The SDK may buffer internally; heap limits do not
  establish total native/helper RSS. Post-write disk checks may retain oversized
  evidence and fence recovery for explicit context handoff. Measurements need
  run at merge; no unbounded resume or total RSS guarantee is claimed.
- Windows home/sandbox/process ownership is unsupported. POSIX parent-death and
  idle cleanup need execution at merge. Exact 1.0.35 remains the admission gate;
  future SDK versions require explicit acceptance.
- Deeper nested task and background completion evidence remains incomplete.
  Late authoritative tool completion across steering now settles the original
  call; incomplete or missing evidence remains uncertain. Children are read-only,
  with no independent send/resume/stop.
- SDK catalog parameters are retained/normalized. Arbitrary parameter selection
  awaits the shared model-selection contract. Billed usage and quota windows stay
  unknown rather than inferred from token totals.
- Separate SDK sign-in and the launch API-key override remain visible. Logout
  deletes only the selected SDK credential store and does not revoke a key or
  remove the environment override. No native ACP-to-SDK checkpoint conversion
  or cross-account checkpoint copying; bounded context handoff preserves source.

Do not merge this branch without the orchestrator's instruction.
