# Verification

Offline verification on this branch uses Vitest, the public adapter contract, core facts and projected client views. Session tests start a boundary double for the installed CLI as a real child process with a real authenticated HTTP/SSE server. They synchronize on received frames and HTTP responses, without sleeps or elapsed-time assertions. No provider prompt or recorder was run.

`bun run check` passed after merging the final foundations packages from main: 411 tests passed, five live tests skipped. The OpenCode package contributes 54 passing tests and one skipped health-only live test. Every production and test module is under 400 lines.

## Fixture timelines

All nine expectation files pass through `@ace/adapter-testkit`'s `replayFixture` and `assertExpectations`, using transport liveness at 25 seconds. The testkit timeline CLI was also run for every fixture with its expectation checkpoint times.

| Fixture             | Checkpoints and final state                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-read           | Working at 1244 and 5568; done at 7231; one agent.                                                                                              |
| approval-edit       | Needs input at 8063, working at 8070, done at 9359; one resolved approval.                                                                      |
| question            | Needs input at 5773, working at 5780, done at 7279; one resolved question.                                                                      |
| plan-review         | Clarifying questions at 71873 and plan review at 113465; done at 113588; two agents and seven resolved interactions.                            |
| subagent            | Child announced at 14528; approvals at 18103 and 23236; root still working at child completion 26694; done at 28789.                            |
| subagent-background | Root blocked while child works at 9703; result delivery at 15621 leaves root working and child idle; done at 18399.                             |
| background-shell    | Healthy reasoning at 100000; approvals at 170232 and 173123; done at 187558; no provider-visible detached shell task.                           |
| interrupt           | Working at 16649, waiting for surviving shell at 16661, done after terminal tool update at 16669; second idle at 16725 leaves root interrupted. |
| retry-overloaded    | Upstream waits at 3378, 73739 and 104673; heartbeats maintain healthy working between retries; final remains waiting.                           |

Core's settled-root/working-child precedence makes the background-subagent thread working while its root is blocked. Pending input is represented by `wake.expected`, whose canonical status is working with starting-turn activity. Those choices keep the tree live and follow the existing core API.

## Behavior coverage

- Late child announcements bind to their later spawn item without creating another agent.
- Busy-before-user child ordering still starts one run and reports reasoning activity.
- Duplicate abort idles cannot settle a surviving shell or create a second run.
- Injected task results complete the background job and label the resumed run `subagent_result`.
- The three-second fallback keeps a job live before its deadline and settles it afterward.
- Rate limits, network failures and overload retries remain blocked until native recovery.
- Native retry timestamps are converted into the injected replay clock.
- Transport heartbeats cover quiet retries; their disappearance becomes unresponsive.
- Reasoning's native text deltas reach reasoning items without modifying input data.
- Rejected questions preserve dismissal and decline the backing tool without failing the turn.
- `plan_exit` opens plan review; observed successful plan writes supply its contents.
- Native authentication errors fail the turn; ordinary assistant error text remains transcript text.
- A failed prompt delivery clears its pending-input wake and reports failure.
- A complete turn missed during disconnection can be recovered as settled.
- Transport loss expires interactions and REST resync can reopen them.
- Unknown payloads stay raw and durable sync twins do not duplicate items.
- Tool-kind mappings render typed details while retaining native names and inputs, including MCP server names with underscores.
- One authenticated process serves multiple directories and forwards file/image/model inputs.
- Queueing waits for children and for the background-result parent's resumed turn.
- Approval replies, ordered question answers, dismissal and plan decisions use their native HTTP routes.
- Cascade interruption aborts descendants; stopping a task addresses its native session.
- Reconnect restores missed child messages, statuses and interactions from REST.
- Deltas received while a snapshot is read do not get appended twice.
- Closing rejects queued input, protects active sessions from idle-close and allows later process restart.
- Relative file attachments resolve inside the session directory.
- Injected time/counters keep outgoing message IDs in native history order.
- Ambiguous model names are rejected before HTTP input is built.
- Unsupported or unrecognized CLI versions are rejected before sessions start.

## Mutation checks

Each mutation below was applied to production code alone, made an existing behavior test fail, then was reverted. The twelve checks ran sequentially. A first probe removing only `detail.childAgent` survived because core reconstructs that hint from `agent.linked`; the final M6 removes the task-kind mapping and fails the foreground-child behavior test.

| Mutation                                         | Failing behavior                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| M1: rate-limit retries become upstream           | holds a rate_limit retry until a busy signal                                  |
| M2: network retries become upstream              | holds a network retry until a busy signal                                     |
| M3: aborted completed tools succeed              | keeps an interrupted shell live through duplicate idles until terminal output |
| M4: plan_exit becomes an ordinary question       | turns plan_exit into a review and treats rejection as a completed turn        |
| M5: question rejection loses dismissal           | resolves rejected questions as dismissed and declines the backing tool        |
| M6: task tool becomes an untyped custom tool     | links an announced child to its later task without creating a second agent    |
| M7: reasoning text deltas use the message field  | routes reasoning text deltas to reasoning and preserves the input frame       |
| M8: background grace expires immediately         | releases a background job after the result-delivery grace period              |
| M9: live tools are cancelled at the first idle   | keeps an interrupted shell live through duplicate idles until terminal output |
| M10: session ignores busy children when queueing | queues a second input until the child and root are both idle                  |
| M11: HTTP requests lose project addressing       | shares one authenticated server and addresses each project directory          |
| M12: recovery replays a delta already in REST    | does not append a buffered delta that the REST snapshot already contains      |

## Boundaries

The optional real-CLI test was not enabled in this run. It starts only the server and reads health after SSE connection, with no session creation or model input. The fixture recordings remain untouched.

The adapter drives v1 routes. `session.next.*` remains raw until a separate v2 translation contract is specified. Detached shells have no native task lifecycle, so capabilities report partial background visibility. Long recovery reads may defer queued input until the stream reaches a quiet point; provider I/O is kept outside the translator.
