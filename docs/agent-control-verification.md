# Agent control verification

Only static verification is permitted in this run. All behaviour tests, mutation cases and benchmark measurements below are **not executed (tests run at merge)**. No real-provider prompts or recorder sessions were used.

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

| Production mutation                                                | Test designed to fail                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| Apply generation reopening only to MCP messages                    | Ordinary engine send accounting/wake/cancellation       |
| Reuse one cascade interrupt ID across generations                  | Reopened subtree's second interruption                  |
| Retry an old interrupt by cancelling current work                  | Reopened subtree's old request retry                    |
| Drop persistent subtree stops or clear them on result turns        | Subtree stop across restart, no automatic wake          |
| Remove launch admission/closed guards                              | Prepared launch, direct send and handoff retry          |
| Create Git resources before reserving admission                    | Handoff capacity rejection leaves no resources          |
| Exclude pending reservations from concurrency                      | Pending Git reservation blocks another delegate         |
| Ignore lease/parent cancellation before acceptance                 | Revoked/cancelled pending Git handoff                   |
| Omit worktree/branch/workspace compensation or reservation release | Failed/revoked handoff and later slot reuse             |
| Delete a preexisting or changed branch during cleanup              | Failed creation preserves branches and Git cleanup test |
| Omit receipt counter triggers or retain rollback reservations      | Capacity settlement/restart/rollback                    |
| Invoke preview cleanup twice for concurrent closes                 | Concurrent preview cleanup                              |
| Remove foreign project authorization                               | Scoped project management                               |
| Close an unregistered preview                                      | Preview ownership                                       |
| Delete a replacement preview after old cleanup                     | Pending preview replacement                             |
| Create another child on handoff retry                              | Worktree handoff receipt reuse                          |
| Omit native resume identity                                        | Distinct native history retained after idle close       |
| Ignore account selection/quota rejection                           | Explicit account/quota test                             |
| Deliver a foreign thread reference                                 | Daemon context delivery                                 |
| Drop ACP identity or replace Claude's scoped lease                 | ACP identity and Claude replacement integration         |

## Performance

`apps/daemon/bench/agent-control.ts` measures durable admission and external status propagation with 32 linked threads and an injected clock, plus usage ingestion and budgeted UTF-8 context summaries. It uses adapter-testkit, never a real provider. Set `ACE_BENCH_HISTORY=0` or `9000` to compare admission with historical receipts. It prints the history size, admission µs/op, status updates/s, usage events/s, summaries/s and peak RSS. Numbers: **needs run at merge**; benchmark execution is prohibited locally.

Admission uses counters and bounded indexed active rows. Status/usage events point-read their edge; the root active counter and partial deadline index exclude completed trees. Ancestor propagation is bounded by maximum depth. Paged transcript summaries cap bytes. Journal receipts reject at capacity, preserving existing idempotency identities. Waiters, preview descriptors and handoff promises are explicitly capped.

The service integrations and native MCP injection require integration execution at merge; static type safety does not prove SDK/runtime interoperability. ACP HTTP MCP support, unsupported option values, fork/queue executor registration, preview registration and optional watcher automation ports remain capability boundaries.
