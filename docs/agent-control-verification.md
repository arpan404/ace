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
- Follow-up messaging wakes again on the same native child thread; retries after completion do not reopen it.
- Large child text is read by bounded byte ranges; streams cannot be substituted across target threads.
- Actual questions resolve through the public engine command API and allow work to settle.
- Repeated cumulative usage is counted once; spending the token budget cancels the tree.
- Elapsed budget cancels silent work without another provider frame.
- Unresponsive and human-waiting children prevent false parent completion.
- Default daemon composition manages owned project names, PR metadata and automation definitions through the public agent-control API.
- Preview closing requires a host registration for the target thread and invokes its owner.
- Real Git worktree handoff starts a linked native session in the worktree and reuses child receipts on retry.
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

## Performance

`apps/daemon/bench/agent-control.ts` measures durable admission and external status propagation with 32 linked threads and an injected clock, plus usage ingestion and budgeted UTF-8 context summaries. It uses adapter-testkit, never a real provider. It prints admission µs/op, status updates/s, usage events/s, summaries/s and peak RSS. Numbers: **needs run at merge**; benchmark execution is prohibited locally.

Admission uses counters and bounded indexed active rows. Status/usage events point-read their edge; the root active counter and partial deadline index exclude completed trees. Ancestor propagation is bounded by maximum depth. Paged transcript summaries cap bytes. Journal receipts reject at capacity, preserving existing idempotency identities. Waiters, preview descriptors and handoff promises are explicitly capped.

The service integrations and native MCP injection require integration execution at merge; static type safety does not prove SDK/runtime interoperability. ACP HTTP MCP support, unsupported option values, fork/queue executor registration, preview registration and optional watcher automation ports remain capability boundaries.
