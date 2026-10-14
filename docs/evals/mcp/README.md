# ace MCP evals

How we judge whether a change to ace's MCP surface makes agents smarter: fewer ace calls, fewer
failed and retried calls, fewer turns and less context, with no loss of success. Every change to
the MCP surface should show a gain here, or be neutral for a stated reason.

## Tier A: scripted agents (CI)

`apps/daemon/src/evals/` runs a small task suite against the **real daemon and the real ace MCP
server**. Provider CLIs and models are scripted (`@ace/adapter-testkit`, scripted model catalog),
so nothing reaches a provider and no quota is spent.

- Each task creates a thread the way a person does. Its scripted provider session receives the
  real ace MCP lease, and a scripted "model" (`agent.ts`) uses it through the official MCP client,
  the way a provider CLI would.
- Each task has an **oracle policy**: the shortest correct path that uses only what a model could
  see (instructions, the tool list, tool results). It measures what the surface makes possible.
- A **checker** judges success from real effects: store state, child outcomes, browser logs.
- **Correctness tasks are hard gates** (`[gate]` in the test names). They must pass on every PR;
  a call-count win never excuses a status regression.

Tasks:

| Id                            | What the agent must do                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `where-am-i`                  | Report project, branch, access mode (Read-only, Ask, Auto review or Full access), whether the title is provisional and how many sibling threads are live |
| `delegate-two`                | Delegate two tasks to another provider and collect both results                                                                                          |
| `browser-check`               | Open the dev server in ace's browser and report its console error and failing request (skipped without Chromium)                                         |
| `recent-work`                 | Find the project's earlier thread and its outcome                                                                                                        |
| `visualize`                   | Render a small HTML comparison                                                                                                                           |
| `recover-bad-argument`        | Six tools, one slipped argument each; repair using only the error payload (proposal P3, test a)                                                          |
| `child-waits-on-human` (gate) | A delegated child is waiting on the person; it must never be reported done                                                                               |
| `read-only-no-screen` (gate)  | In a read-only thread, screen and device tools are absent and never attempted, while a full-access control thread on the same daemon is offered them     |

Metrics per task: success, ace calls, calls to the model's own tools (for example `git branch`),
failed calls, identical retries (a failed call repeated with the same arguments), turns (model
steps; parallel calls share a step; the final answer is one), and estimated tokens. Tokens are
UTF-8 bytes / 4 over the instructions the provider receives, the tool descriptors (name,
description, input schema) and all call traffic. The catalogue table adds tool count, `tools/list`
size, output schema size and the instructions each provider receives through every channel ace
uses for it.

Run it:

```sh
bun run eval:mcp                                     # writes output/evals/mcp-latest.{json,md}
ACE_EVAL_REPORT=docs/evals/mcp/after ACE_EVAL_LABEL=after bun run eval:mcp
```

It also runs in CI as part of `bun run test` (process project). Reports are written only when
`ACE_EVAL_REPORT` is set.

Committed reports:

- [`baseline.md`](baseline.md) / `baseline.json`: `main` at bb84cd3ed (after #672, #675 and
  #685's access modes), before any change. Before #685 the read-only gate failed: a Codex thread
  in `:read-only` was still offered `screen_request_app`, because the check compared native mode
  names. #685's canonical access mode makes that check correct, and the gate keeps it so.

## Tier B: live models (owner-triggered only, never in CI)

Not built, and never run without the owner asking: it spends subscription quota. It is separate
from `tools/recorder`. When the owner asks, it would work like this:

1. An explicit opt-in: `ACE_EVAL_LIVE=1` plus a named provider and account
   (`--provider claude --account <id>`). Without both, the runner refuses to start.
2. The same tasks and checkers, but the scripted provider is replaced by the real installed,
   logged-in CLI, given the task as its first prompt in a temporary fixture repository.
3. N = 5 runs per task per provider, before and after a change. Report the median and
   interquartile range of ace calls, wrong-tool calls, turns, and input/output tokens from the
   provider's own usage events (ace already records them), plus the success rate.
4. A change "ships as proven" when the median improves without lowering success on any provider.

## Tier C: local telemetry (not built)

From data ace already stores (ADR 0069 evidence, refusal notices, usage), per thread:
`invalid_arguments` rate, identical-failure retries, `ace_status` calls, delegation refusals, and
median ace calls per delegated child. It stays on the person's machine.
