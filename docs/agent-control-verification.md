# Agent control verification

Earlier fix rounds used static verification only. The #69 main-merge round used the owner's explicit merge-conflict exception: 113 unique tests passed in 19 selected files touching the conflicted engine, service composition, native sessions and MCP interfaces. No full suite, mutation runs, benchmarks, CI, real-provider prompts or recorder sessions were used. Coverage outside those selected files and performance measurements still **need run at merge**.

## Merge-conflict verification after #74

Merged main `41df1b1d` without rebasing. Resolved capability lists as a union of browser, agent control, automations, projects and notifications. Daemon MCP composition retains both toolkits and the legacy delegation callback. The engine's scoped lease passes through main's provider wrapper without replacement, preserving lifetime revocation and native live execution configuration. Generic ACP keeps its negotiated lease; Claude and Pi retain their existing lease ownership.

Codex keeps main's subcommand-first launch order and redaction, with URL/bearer projection for strict injection schemas. OpenCode uses main's canonical bounded JSONC configuration merge instead of a duplicate local parser, and main's weak lease identities isolate native processes without retaining expired lease objects. Lifetime fields are projected before strict parsing; native transport and MCP credential redaction both remain enabled.

Under the explicit merge-conflict exception, **58 unique tests passed in 12 selected files**: daemon `browser-provider-mcp`, `provider-mcp-lease`, `browser-mcp`, `browser-pi-mcp`, `claude-registration`; agent-control `pi-mcp`, `owners`, `acp`; Codex `session`, `fork-selection`; OpenCode `v2-scoped-mcp` (all `.process.test.ts`); and MCP `injection.test.ts`. The first run passed 55 and found three test expectation/fixture mismatches. After aligning the redaction marker, issued Pi scope and native settings/turn contracts, those three files passed all 12 tests. No other files were rerun.

New public regressions observe the combined authorized tool list, native browser access with an inherited engine lease, model/effort/tier changes in native settings and turn traffic, shutdown revocation, user JSONC preservation and account-peer lease isolation. The synthetic Codex CLI rejects options before the `app-server` subcommand. These checks use synthetic providers and browser backends; no installed provider or real browser binary was launched.

Took main's lockfile, installed combined dependencies and regenerated 486 protocol reference artifacts. Static checks passed: formatting, lint, typecheck, file-size and diff checks. Full `bun run check`, full suite, CI, benchmarks and mutation runs were not executed. Performance numbers still **need run at merge**.

## Merge-conflict verification after #69

Merged main `2af0ce68` without rebasing. Took main's lockfile, installed the union of workspace dependencies and regenerated protocol documentation with `bun run docs:protocol`.

- Fork lineage stays separate from delegation ownership: cancelling a fork's children leaves source children running, and source results wake only their original parent.
- A switched delegated thread retains its root identity, parent summary and follow-up concurrency accounting; original-owner cancellation still reaches prepared grandchildren.
- Interrupting a queued whole-session fork releases its source guard and never opens the cancelled fork, allowing the independent source to continue.
- Switches require whole-tree quiescence, while `subagent_result` turns can run beside independent live children. Cancelling a subtree fails its queued switch rather than applying it after interruption.
- Native Codex turns use the current effort/tier after reconfiguration. Native Claude merges user MCP servers with the scoped ace lease and accepts cleared effort.
- Claude and Codex injection project the URL/bearer connection from the lifetime-scoped lease before strict schema parsing. Credentials remain redacted from recorded frames.
- A disconnected external child makes its parent unresponsive rather than hiding behind an aggregate background-wait status. The batched-result regression inspects input received by the fake provider, which does not emit synthetic user-message items.

The selected passing files were `engine/{thread-fork,thread-switch,transition-regressions,thread-merge-account,transition-acp}.process.test.ts`, `agent-control/{control,lifecycle,preparation,context-delivery,transitions,accounts,recovery,owners}.process.test.ts`, daemon `claude-registration.process.test.ts`, both adapters' `{fork-selection,session}.process.test.ts`, and MCP `injection.test.ts`. The initial expanded run was interrupted after discovering the strict lease boundary error; the final grouped run passed 112 tests in these 19 files. After adding a queued-fork interruption regression, the updated five-test transitions file also passed (113 unique passing tests). Before fixes, public tests demonstrated the queued-switch cancellation and lifetime-lease failures; the original control regression demonstrated the unresponsive-parent failure.

The remaining MCP fork/merge owner bridge is deliberately gated. Main's fork command requires continuation input and a finished boundary; merge requires authored summary/citations and authorization on its source. The older MCP operations do not carry that full contract. Adapting them requires a schema and ownership change, not an unchecked translation. Editable queues and Deck executor registration remain host integration boundaries.

## Behaviour coverage

- Cross-provider child selection, native context options, independent history, wait, parent linkage and `subagent_result` wake.
- Two completions produce one result turn containing both results while another child remains active.
- Background shell completion controls child and parent settlement, independently of foreground turn end.
- Cascade interruption cancels children and grandchildren, prevents prepared-child launch, and suppresses wakes.
- Per-parent concurrency and maximum depth reject admission without leaving new threads; completed work frees a concurrent slot.
- Idempotent retries reuse a child; conflicting request identities fail.
- Fake question answers targeting approvals fail at the stored-kind guard; actual approval answers fail at the MCP schema boundary.
- Children read parent context but cannot interrupt ancestors or unrelated threads.
- Pending results survive owner restart and produce no duplicate wake after receipt consumption.
- A SQLite backup taken during live work simulates a crash; engine recovery reports uncertainty instead of opening/replaying the child session.
- Cancellation during provider opening aborts before sending and retains parent liveness until opening cleanup completes.
- Follow-up messaging closes the idle process, resumes its distinct native ID/history, wakes again and does not reopen on completed retries.
- Ordinary UI/engine sends reopen accounting, enforce concurrent slots, wake again and participate in cascade cancellation.
- Repeated subtree interruption uses a new receipt; old request retries do not interrupt reopened work. Durable stops suppress automatic wakes across restart, while sibling work survives.
- A settled descendant's surviving MCP scope cannot prepare children beneath a stopped parent or grandparent, including after owner restart. Denials leave no threads/linkage/status revival and consume no remaining receipt/tree capacity; explicit ancestor reopening permits preparation.
- A reservation acquired before ancestor interruption cannot commit a prepared child after the stop. The host can release it and reuse capacity after explicitly reopening the ancestor.
- Closed admission blocks prepared launch, direct engine sends and handoff retries.
- Large child text is read by bounded byte ranges; streams cannot be substituted across target threads.
- Actual questions resolve through the public engine command API and allow work to settle.
- Repeated cumulative usage is counted once; spending the token budget cancels the tree.
- Elapsed budget cancels silent work without another provider frame.
- Unresponsive and human-waiting children prevent false parent completion.
- Default daemon composition manages owned project names, PR metadata and automation definitions through the public agent-control API.
- Preview metadata is bounded before registration; a stale close cannot remove a replacement preview.
- Preview closing requires a host registration for the target thread and invokes its owner; concurrent closes share one cleanup.
- Handoff rejection creates no branch, worktree or workspace; reservations count against concurrent slots before Git finishes.
- Lease revocation and parent cancellation while Git is pending prevent child acceptance, compensate Git resources and release reservations. Failed creation preserves preexisting branches; changed pending-worktree commits survive cleanup and hold a bounded reservation.
- Native account/quota mismatch fails before child creation and eligible assignments reach the native session.
- Receipt capacity survives settlement/restart; preparation rollback releases capacity.
- Authorized daemon thread-reference delivery obeys byte budgets/pointers; a foreign workspace cannot reach provider input.
- Registered canonical thread owners handle metadata after agent authorization; child-to-ancestor writes remain denied.
- Approved ACP identity reaches the independent native thread. Claude synthetic CLI controls retain agent-control tools across MCP replacement.
- OpenCode v2 synthetic native processes preserve user MCP definitions and isolate thread authority in one account; revoking one lease leaves the peer usable.
- Pi daemon registration retains the engine's scoped agent-control lease, exposes the authorized tools and revokes access on shutdown through a synthetic RPC peer.
- Autonomous spawn/parent/result/schedule runs release queue ownership so the next message reaches the provider and produces an observable assistant result.
- Real Git worktree handoff starts a linked native session in the worktree and reuses child receipts on retry and rejects conflicting concurrent handoff identities.
- Native loopback MCP leases delegate across providers and reject child-to-parent interruption.
- Thread references retain paging pointers, explicit truncation, untrusted-data labels and a UTF-8 byte budget.

## Designed mutation kills

Every case is **not executed (tests run at merge)**.

| Production mutation                                                             | Test designed to fail                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Prepare the child using the parent provider instead of requested provider       | Cross-provider selection/wait/wake                     |
| Drop model or options from the child session row                                | Cross-provider selection/wait/wake                     |
| Omit the external child summary from the parent's core tree                     | Cross-provider linkage/status                          |
| Change result turn trigger to `user`                                            | Cross-provider wake and batched wake                   |
| Consume pending results without committing a wake command                       | Cross-provider wake and restart result recovery        |
| Enqueue one wake per child rather than one coalesced batch                      | Batched completion with another live child             |
| Settle on foreground turn end while background work survives                    | Background shell settlement                            |
| Skip grandchildren during cascading cancellation                                | Cascade interruption                                   |
| Leave a prepared child uninterruptible or allow it to launch after cancellation | Cascade interruption/prepared launch prevention        |
| Replace `depth >= maxDepth` with `depth > maxDepth`                             | Depth admission rejection                              |
| Skip concurrent-child rejection or fail to free a completed child's slot        | Concurrent admission and slot reuse                    |
| Remove the stored question-kind guard                                           | Approval disguised as question                         |
| Permit approval values in the question tool schema                              | MCP approval-answer validation                         |
| Authorize any same-workspace mutation instead of own thread/descendants         | Ancestor/unrelated-thread interruption denial          |
| Discard pending result journal rows on startup                                  | Durable result recovery                                |
| Replay uncertain child input after crash                                        | SQLite crash-snapshot recovery/no child session replay |
| Add cumulative usage in full on every sample                                    | Cumulative budget test                                 |
| Remove the independent budget deadline                                          | Silent elapsed-budget cancellation                     |
| Treat silent external summary agents as irrelevant placeholders                 | Unresponsive-child settlement                          |
| Permit output reads without checking stream thread ownership                    | Large-output stream substitution denial                |
| Slice UTF-8 summaries by character count without accounting for bytes           | Multibyte thread-reference budget                      |

Additional review regression mutations are all **not executed (tests run at merge)**.

| Production mutation                                                | Test designed to fail                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Apply generation reopening only to MCP messages                    | Ordinary engine send accounting/wake/cancellation        |
| Reuse one cascade interrupt ID across generations                  | Reopened subtree's second interruption                   |
| Retry an old interrupt by cancelling current work                  | Reopened subtree's old request retry                     |
| Drop persistent subtree stops or clear them on result turns        | Subtree stop across restart, no automatic wake           |
| Remove launch admission/closed guards                              | Prepared launch, direct send and handoff retry           |
| Create Git resources before reserving admission                    | Handoff capacity rejection leaves no resources           |
| Exclude pending reservations from concurrency                      | Pending Git reservation blocks another delegate          |
| Ignore lease/parent cancellation before acceptance                 | Revoked/cancelled pending Git handoff                    |
| Omit worktree/branch/workspace compensation or reservation release | Failed/revoked handoff and later slot reuse              |
| Delete a preexisting or changed branch during cleanup              | Failed creation preserves branches and Git cleanup test  |
| Omit receipt counter triggers or retain rollback reservations      | Capacity settlement/restart/rollback                     |
| Invoke preview cleanup twice for concurrent closes                 | Concurrent preview cleanup                               |
| Remove foreign project authorization                               | Scoped project management                                |
| Close an unregistered preview                                      | Preview ownership                                        |
| Delete a replacement preview after old cleanup                     | Pending preview replacement                              |
| Create another child on handoff retry                              | Worktree handoff receipt reuse                           |
| Omit native resume identity                                        | Distinct native history retained after idle close        |
| Ignore account selection/quota rejection                           | Explicit account/quota test                              |
| Deliver a foreign thread reference                                 | Daemon context delivery                                  |
| Drop ACP identity or replace Claude's scoped lease                 | ACP identity and Claude replacement integration          |
| Share an OpenCode process between scoped thread leases             | OpenCode native MCP authority isolation/revocation       |
| Drop user MCP definitions during OpenCode injection                | OpenCode native MCP configuration preservation           |
| Replace Pi's engine lease with a narrower registration lease       | Pi daemon MCP tools and shutdown revocation              |
| Exclude autonomous run triggers from input acknowledgement         | Agent-trigger admission and next-message delivery        |
| Admit preparation beneath a stopped ancestor                       | Surviving descendant MCP preparation denial and capacity |
| Check only the immediate parent, omitting a stopped grandparent    | Settled descendant two levels below a stopped ancestor   |
| Omit ancestor validation when committing a pre-stop reservation    | Reserved preparation after ancestor interruption         |
| Retry result wakes beneath a stopped ancestor                      | No descendant wake or error retry after ancestor stop    |

## Performance

`apps/daemon/bench/agent-control.ts` measures durable admission and external status propagation with 32 linked threads and an injected clock, plus usage ingestion and budgeted UTF-8 context summaries. It uses adapter-testkit, never a real provider. Set `ACE_BENCH_HISTORY=0` or `9000` to compare admission with historical receipts. It prints the history size, admission µs/op, status updates/s, usage events/s, summaries/s and peak RSS. Numbers: **needs run at merge**; benchmark execution is prohibited locally.

Admission uses counters and bounded indexed active rows. Status/usage events point-read their edge; the root active counter and partial deadline index exclude completed trees. Ancestor propagation is bounded by maximum depth. Paged transcript summaries cap bytes. Journal receipts reject at capacity, preserving existing idempotency identities. Waiters, preview descriptors and handoff promises are explicitly capped.

The selected fake-provider service/native MCP integrations passed under the merge-conflict exception. Real installed-provider interoperability still needs run at merge. ACP HTTP MCP support, unsupported option values, fork/queue executor registration, preview registration and optional watcher automation ports remain capability boundaries.

## Additional designed mutations for the merge

All mutation applications are **not executed (tests run at merge)**.

- Inherit source delegation edges into a fork: independent-fork cancellation/result test.
- Reparent switched-thread children or bypass reopened admission: switched-child ownership/concurrency test.
- Execute a switch before delegated children settle: queued-switch/result-wake test.
- Cancel sends but leave a queued switch alive: subtree cancellation test.
- Reuse opening-time Codex options after configure: native effort/tier follow-up test.
- Replace Claude user MCP servers with ace, or ace with user servers: combined native MCP test.
- Pass lifetime fields into strict connection schemas: native scoped-lease tests.
- Ignore disconnected external children in whole-tree status: unresponsive parent test.

- Retain a queued cancelled fork's source guard: queued whole-session fork interruption test.

## Additional designed mutations for browser integration

All mutation applications are **not executed (tests run at merge)**.

- Remove browser or agent-control authority from native leases: combined native tool discovery and browser access.
- Replace an inherited engine lease in the provider wrapper: inherited-lease browser access and close revocation.
- Drop native configure forwarding: observed model settings and updated effort/tier on the next turn.
- Move Codex injection options before the subcommand: synthetic native CLI startup/browser proof.
- Pass lifetime fields into strict OpenCode schemas: scoped native MCP thread-authority test.
- Replace canonical JSONC injection with JSON-only parsing: user configuration preservation with comments/trailing commas.
