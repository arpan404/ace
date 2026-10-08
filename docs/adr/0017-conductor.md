# 0017: Conductor project orchestration

Date: 2026-10-02. Status: proposed, implemented behind executor ports.

## Context

The backend build required a human to divide a goal into workstreams, assign isolated branches, move sessions between subscriptions, challenge worker output, request fixes and merge in dependency order. Conductor should own that loop. The human owns policy decisions and exceptions.

The supplied feature inventories at `/tmp/ace-orch/research-t3code.md` and `/tmp/ace-orch/research-competitors.md` describe parallel worktrees and reviews in t3code, Codex, Claude Code and Cursor, and project coordinators in Cursor and Antigravity. They do not establish an end-to-end durable loop with account migration, adversarial review evidence and dependency-ordered verification. This is a gap in the inventories, not a claim that those products cannot do it. No competitor source code was used.

## Decision

Add `@ace/conductor`, with a pure reducer, bounded Zod artifacts, a scheduler, prompt builders, executor ports and a SQLite journal/outbox shell. Facts carry a lane generation; late results from an earlier session cannot finish its replacement. Completion requires both the canonical whole-thread `done` status and the role's artifact, in either order. Done without an artifact starts a fixed arrival deadline using `stallAfterMs`; expiry creates an escalation. Repeated done observations cannot move that deadline, even while acknowledgement is withheld. The first buffered done timestamp and artifact deadline persist while the latest activity timestamp separately fences stale observations; ticks can escalate before acknowledgement without destroying the acknowledgement barrier. Replacement-generation observations emitted during awaited migration are latched durably, one latest status plus the role artifact, and settled after acknowledgement. Provider deltas never enter this reducer. The engine continues to own tree status.

The plan contains at most 256 workstreams, explicit briefs, acceptance criteria, priorities, dependency ids, file/package ownership and risks. Validation rejects cycles, missing dependencies, duplicate acceptance criteria, unsafe paths and overlapping ownership unless the owners are dependency-ordered. A path trie compares only overlapping owners. The I/O shell probes case semantics on the workspace volume and injects a pure lookup; the reducer persists the result and checks Unicode-normalized aliases and a locale-independent lower-then-upper casing closure on insensitive filesystems. This conservatively covers final sigma, long s and capital sharp s as well as ASCII aliases. It can group names a particular volume considers distinct, requiring their owners to be dependency-ordered. This favors conflict prevention over admitting extra parallel owners. [Unicode explains why lowercasing alone is insufficient for caseless matching](https://unicode.org/faq/casemap_charprop.html); [Apple documents APFS normalization and Unicode 9 semantics](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html). A diagnostic comparison covered all 1,429 common/simple/full Unicode 9 folding entries without vendoring Unicode data or code. Unknown semantics default conservatively to insensitive. Plan edits undergo the same admission checks. Plans and reports are capped by serialized UTF-8 byte counts. Plan edits replace the artifact before approval. Approval policies are explicit. Account/model/provider allowlists apply to every role, including migration. Reviewers prefer a different provider or model and always use normal speed. Each node retains review summaries and only the latest full report for fix prompts. Reports require requirement verification, probes, at least 15 distinct mutations with observed failures, flakiness, design and performance evidence before a passing verdict can integrate.

Ready work is scheduled by descending priority, then plan order. Dependencies become satisfied only after integration checks pass. Account reservations count planning, coding, review, migration and integration lanes. Quota snapshots exclude Conductor's own reservations; capacity reports external sessions separately. A usage-limited lane migrates with its complete history, or waits for a later accounts snapshot. Fixes fork the worker session with the review. Review exhaustion, stalled/failed lanes, budget reservations above the budget, deadline expiry, requested merges and destructive operations create user gates and notification intents. Rejection never silently bypasses a gate. It answers the gate's own question: a rejected plan is dropped and the planner drafts another, told which summary was rejected; a rejected merge, escalation or destructive change declines its card, which stops that card's lanes, never merges and leaves its dependants unstarted while the rest of the run continues; a rejected budget, deadline or other gate not about a card cancels the run. A run whose remaining cards are all declined or waiting on declined cards is done.

Local merges are serial. Merge completion and verification are separate durable steps. Conflicts fork the owning worker or an integrator for a declared trivial conflict, then require another review. PR-only creates a PR and requires CI verification before its dependencies become ready. It does not merge the PR; the report names that distinction. Pause stops scheduling and requests lane suspension. Cancel requests cascade stops and only reports cancelled after live lanes settle. Gates and live descendants prevent a done result.

## Ports and durability

`@ace/orchestrator` from ADR 0013 and `@ace/git` landed on main as PRs #19 and #9 and were merged here, alongside engine API/testkit, remote access, MCP, notifications, relay, payload streaming and model catalogs. Orchestrator's public create/apply/recover/execute API owns primitive orchestration runs and delegates thread/worktree execution to engine ports. GitService owns worktrees, checkpoints, diffs and restoration; it has no commit/three-way merge operation. Conductor retains narrow ports for role-specific sessions, root-tree attachment, verified branch integration and account migration. The engine lane runtime, accounts and forge implementations remain pending. Their adapters will bridge these public packages without duplicating provider execution or collecting credentials. The engine port starts/forks/controls a lane, quiesces completed sessions while retaining forkable history, and emits canonical tree-status facts; the orchestrator port attaches each lane to the run's root; git prepares a worktree and integrates a reviewed branch; forge creates a PR; accounts migrates a session with history; verification checks the resulting immutable revision. No provider CLI is invoked in this PR.

Every effect has a stable idempotency key. Executors must persist their own receipts and reconcile git/forge/session effects by that key after a crash. SQLite atomically commits changed state rows, input receipts and effects. A store caches at most eight immutable admitted run actors, with explicit backpressure and terminal release. It parses immutable artifacts at admission or cold restore. Storage version 2 puts metadata, lanes and nodes in separate rows and references content-addressed artifacts, so an ordinary heartbeat writes one lane and its receipt. Legacy full snapshots upgrade in one transaction. Cache publication happens only after commit. The store requires one writer per run; another connection may read durable rows but cannot concurrently own the same actor. A completed effect and its resulting facts commit together. Failed execution leaves the effect pending. Restart drains those same ids. Exactly-once external side effects cannot be promised by a database transaction alone; idempotent ports are mandatory. One driver per run serializes facts and effect execution. Rejected facts do not poison the journal. Pending inputs can still settle lanes while paused.

State does not retain stream output or an event history. Completed planner/reviewer lanes are removed from scheduling indexes; only the current worker session per workstream remains addressable, and the engine owns older session history. Limits cap workstreams, accounts, lanes, gates, artifact text and pending effects. Each actor retains at most 1,024 artifact references and 32 MiB of serialized artifact data; transactional compaction removes unreferenced artifacts. Data receipts cap at 65,536 with a 1,024-control reserve. Cancellation and terminal cleanup remain admissible after that reserve fills without new receipts, relying on idempotent cancellation and generation fencing. Ordinary outbox effects cap at 1,024, controls at 2,048 and cancellation cleanup at 3,072. Cancellation prunes obsolete gate opens and suspension/resume controls. Deleting a terminal run cascades its rows; the caller caps durable run retention. A transition copies bounded current indexes and scheduling scans only the bounded current DAG/accounts, never transcript history. Immutable plans are not revalidated or serialized on heartbeat. Cold restore validates all persisted boundaries and content digests. Benchmarks measure installed-plan persistence as well as pure scheduling; client progress is derived on request.

## Protocol and wire additions

Add schema-only `packages/protocol/src/conductor.ts` and an export. `CommandPayload` accepts `conductor.start`, `conductor.approve`, `conductor.pause`, `conductor.resume`, and `conductor.cancel`. Start carries the root agent, workspace, goal, repository rules, constraints and policies. Approval targets a durable gate id and can carry a replacement plan, an increased budget or an explicit retry decision. Existing command receipts supply transport idempotency. The daemon's existing injected handler remains the integration seam; its development stub returns `not_implemented` until an engine is wired. No new websocket transport or competing approval store is introduced.

Conductor's progress API exposes DAG nodes, active lanes and generations, quota reservations, review verdicts, merge revisions and open gates. An executor maps gates onto ace interactions and notification intents in one operation. Root/child attachment is compulsory before starting a session. Failed attachment must not launch an invisible lane.

## Security

Use only installed, logged-in local CLIs through the engine. Account ids are opaque references, never credentials. Treat briefs, repository rules and review text as untrusted prompt content, delimited in templates. Artifacts cannot grant permissions. Dedicated response schemas strip unexpected port fields before trusted fact type, operation id, workstream and revision fences are assigned by the executor. Merge approval is scoped to the branch revision reviewed; a changed revision requires a new review. Executor implementations enforce repository boundaries, validate git refs, use argument arrays and never interpolate artifacts into shell commands. Destructive operations require an explicit gate. Remote clients use the existing authenticated command channel and first-answer-wins interaction mapping.

## Testing and delivery

Test public transitions, scheduler outputs, prompts and progress. Exercise invalid plans, capacity/quota/priority, out-of-order completion, stale generations, gates, fixes, migration/reset, cancellation, merge verification and replay. A deterministic six-workstream simulation includes account migration, two failed reviews before passing, a conflict and an escalation answered by the user. Real temporary SQLite files test atomic commits, reopen, actual approval retries, migration observations before acknowledgement, full-history preservation, saturated receipt/outbox cleanup, cache rollback, legacy upgrade and outbox recovery. Real workspace inode probes test case semantics and composed/decomposed Unicode aliases. Buffered repeated-done tests with withheld acknowledgement guard both deadlines, cold restore and late-artifact escalation. Unicode reports/plans test UTF-8 caps. A restored live retiring lane at final verification tests the root terminal guard, and prompts assert exact quoted reviewer rules. Each review blocker was reproduced with a failing public-API test before its fix. Fake ports represent unavailable executors, not internal decision logic. Apply twenty-two production mutations and record the failing behavioural test for each, including removal of the live-lane terminal guard and reviewer repository rules. Both mutations survived the initial review and now fail assertions. The verifier's NFC-normalization survivor now fails a real-filesystem admission test. A dedicated non-gating probe measures the full-state-reparse mutation; performance has no wall-clock gating assertion. Run the repository check and a non-gating scheduling/status benchmark with throughput and RSS before opening the PR.

Current delivery policy: tests run once at merge. Worker validation is formatting, lint, typechecking and the 1,500-line size check only. Behaviour tests remain part of the implementation; mutation cases are marked “not executed (tests run at merge)”. Existing benchmark and load-comparison artifacts are historical measurements from before this policy changed. Any current execution or performance-verification claim needs run at merge.

## Lifecycle and artifact correction amendment, 2026-10-07

A stop retires a lane immediately when its latest whole-thread observation is
already done or failed. Other lanes remain live until the engine proves
settlement. Permanent stops cancel pending provider interactions and inputs,
including descendants. After 30 seconds, the host closes the owned sessions
through the engine; a failed close retains the live lane and is retried rather
than reporting false completion. Retired planner and reviewer scheduling rows
are removed, while the daemon keeps their readable thread bindings.

Working activity or a valid artifact closes that lane generation's stall
escalation automatically. Pause/resume gives live work a fresh activity anchor.
Starting lanes held behind a plan, budget, deadline or card gate have no stall
deadline until the gate opens. A failed integrator retry preserves its role and
conflict context. Completion consumes conflict instructions so later review
fixes do not inherit them.

Prompts give complete JSON envelopes and object shapes. Admission accepts bare
JSON or one JSON fence surrounded by prose. Validation failures produce up to
two correction turns in the same lane before the existing missing-artifact
escalation. Retry counts, rejected message identities and correction admission
barriers are durable. A passing review still covers each acceptance criterion
verbatim; a changes_required report may stop after a failing subset of known
criteria. A changes_required review may stop early with explicit failure
or blocking evidence; a pass still requires fifteen distinct caught mutations,
two repeat runs and passing evidence throughout.

Verification failure restores the integration tree before opening an escalation
or releasing the integration slot. Native Git records the pre-merge revision
and creates a forward revert commit, including a normal PR branch push. A
verification retry starts its worker at the restored integration state. Dirty
or externally moved integration worktrees fail closed and require repair; no
card can be declined while rollback remains incomplete. Cancelling pending CI
performs the same rollback without waiting for CI.

New fake-daemon runs execute the same browser-safe reducer and artifact parser.
The fake scripts provider/engine/Git effects; lifecycle decisions are shared.
Legacy seeded demo cards remain presentation scenarios, with cancelled provider
questions and plan-only root mirroring. UI labels and routes are unchanged.
