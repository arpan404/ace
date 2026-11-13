# Autonomy: access levels, the auto-review, tasks that keep going

Date: 2026-11-13. As built for [ADR 0144](../../docs/adr/0144-spade-autonomous-bots.md). Extends
[harness.md](harness.md), [workspace.md](workspace.md), [oversight.md](oversight.md) and
[agents.md](agents.md). The pure rules are `spade_core::autonomy` and `spade_core::task`; the
engine side is `engine/autonomy.rs`, `engine/calls.rs` and `engine/continuation.rs`.

## Access levels

| Level         | A call the rule gate would ask about                                  |
| ------------- | --------------------------------------------------------------------- |
| `ask`         | asks the person (unchanged; the ADR 0135 review still applies)        |
| `auto_review` | goes to the reviewer, unless it is one that always asks (below)       |
| `full_access` | runs                                                                  |

Calls the rule gate runs (reads, notes in a clean turn, writes allowed always) run on every level.
On `auto_review` the ADR 0135 review still checks those when it is switched on.

- Stored as `{"type":"access_changed","level"}` in the bot's conversation; the latest holds. No
  event means the new-bot level (`auto_review`). The first start of this build stores `ask` for
  every conversation it finds (setting `access_levels_pinned`).
- Read from the events loaded just before each step's calls are gated: a change applies from the
  bot's next tool call.

### Always the person

On `auto_review` these never reach the reviewer; `call_reviewed` is stored with `model: ""` and
the bubble's `reviewer_reason` names the rule:

| Kind              | How it is recognised                                                  |
| ----------------- | --------------------------------------------------------------------- |
| payment           | `pay`, `purchase`, `buy`, `checkout`, `charge`, `order`, `transfer`…  |
| credentials       | `password`, `token`, `key`, `permission`, `role`, `invite`, `access`… |
| message as you    | `send`, `reply`, `forward`, `email`, `message`, `dm`, `chat`…         |
| publish           | `post`, `publish`, `share`, `comment`, `deploy`, `merge`, `upload`…   |
| delete outside    | `delete`, `remove`, `trash`…, or `destructiveHint` / destructive risk |
| unknown           | a tool of Spade's not in its table, or an app tool with no annotations |

Words come from the tool's name (split on `_`, `-`, `.` and camelCase), then the first three
words of an app tool's description. Spade's tools that stay inside the bot (`workspace_*`,
`shell`, `memory_*`, `todo`, `task_status`, `skill_*`, `routine_*`, `image_generate`,
`share_file`) and those that reach another bot (`bot_message`, `group_ask`) go to the reviewer.
ace's tools and app tools that match nothing go to the reviewer, except after untrusted content,
when they ask.

### The reviewer

`review_model` from `/v1/oversight`, else the fast model, else the bot's own. Typed output:

```json
{ "verdict": "approve" | "refuse" | "escalate", "reason": "one sentence",
  "outward_or_irreversible": false }
```

- `approve` runs; with `outward_or_irreversible` it escalates instead for `shell`, and for any
  call in a turn that read untrusted content.
- `refuse`: the call's result is `Not run: <reason> Don't try the same call again; …`, not an
  error.
- Failure, a 60 s timeout, unparseable output or a cap: escalates with the reason.
- Status line while it reads: `Checking a step`.

### Credentials

On `auto_review` and `full_access`, a non-read call whose arguments name a credential place
(`.codex/auth`, `.claude/.credentials`, `.claude.json`, `.config/gh/hosts`, `gh auth token`,
`.gemini/oauth`, `.config/opencode`, `.aws/credentials`, `.ssh/`, `.netrc`, `.git-credentials`,
`security find-generic-password`, …) is refused: `Not run: Spade never lets a bot read sign-in
tokens, keys or provider credentials.`

## Tasks that keep going

`task_status {status, note?}`: `working`, `waiting`, `blocked_on_person`, `done`. Risk read; the
latest valid call is the state.

When a reply ends finished, `spade_core::task::next(events, policy)` decides:

| Condition                                                        | Result               |
| ---------------------------------------------------------------- | -------------------- |
| reply stopped, failed or cut off; Stop since; a job running      | nothing              |
| task not `working`; already paused since the latest message      | nothing              |
| 25 steps since the latest message                                | pause (`budget`)     |
| the last 3 steps had no effect                                   | pause (`no_progress`) |
| the last step had an effect                                      | continue now         |
| the last *n* steps had none                                      | continue after 30 s × 2ⁿ⁻¹, at most 15 min |

An effect is a started call of risk write, destructive or memory, or a `todo` / `task_status`
call with arguments different from the one before it. The engine also starts nothing while the
bot is at a cap, Spade is closing, or the person has the bot's computer.

A continued step is stored as `task_continued {step, nudge}` followed by `reply_started`, in one
write. The model reads `nudge` (`<continue step="n">…</continue>`) as a note from Spade; CLI
brains get it as their next turn. The step's taint reaches back to the latest message. A pause is
`task_paused {reason, steps}`, stored once.

Stop on an idle bot with a step waiting stores `stop_requested` with no reply and calls the step
off.

## API

- `POST /v1/agents` and `PATCH /v1/agents/{id}` take `access`: `ask`, `auto_review` or
  `full_access` (anything else is `400`).
- Every agent shows `access`, `task_state` (`{"status","note"?}` or `null`) and `continuing`
  (`true` while a step Spade started runs or one waits to start).
- `approval_requested` events carry `reviewer_reason` when the auto-review sent the call to the
  person.
- `GET /v1/agents/{id}/activity`: kinds `access` (name is the level) and `task` (`continued`,
  `paused`); `review` entries' outcome is `allowed`, `escalated` or `refused`.
