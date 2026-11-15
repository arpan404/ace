# 0152: A Spade bot hands part of its work to helpers

Status: accepted. Date: 2026-11-14. Decided by: the owner (2026-11-14, with
[ADR 0151](0151-spade-skills-and-plugins.md)). Builds on [spade/docs/harness.md](../../spade/docs/harness.md)
(turns, background jobs), [ADR 0132](0132-spade-teams.md) (teams),
[ADR 0135](0135-spade-research-and-oversight.md) (research, spending caps) and
[ADR 0144](0144-spade-autonomous-bots.md) (autonomy).

Amended by [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md): no fixed step, cost or time
limit ends a bot's work.

## Context

A bot does all of a task in one conversation. Every page it reads and every file it searches
stays in its context until compaction, so a long task fills the context with material only one
step needed, and work that could run side by side runs one step at a time. A bot can message other
bots (teams), run `research`, or start an ace agent, but each of those is heavyweight: another
bot the person manages, one fixed job, or a coding thread in the Threads panel.

## Decision

1. **A helper is a short-lived loop on the bot's behalf.** The bot calls
   `helper {task, profile?}`. The helper starts with a fresh context holding Spade's rules, the
   profile's instructions and the task, nothing of the conversation, and works until it answers.
   Its final message is the call's result.
2. **A helper is a background job** (harness.md): the call answers at once, and the result arrives
   as a `<job_result>`. So a bot can start several and carry on; at most 4 run at once per bot, and
   a fifth waits for a free slot. While any helper runs, the conversation reads as working.
3. **A helper's events are stored as their own hidden conversation**, linked to the call that
   started it. It is driven by the same `next_step` as any turn, so it streams, retries, compacts,
   pauses for updates and resumes after a restart. Unlike other jobs, a helper cut off by a restart
   carries on from its events rather than reporting "unknown outcome", since nothing about it is
   lost. Stop on the bot's reply stops its helpers.
4. **Profiles say what a helper is for.** Built in:
   - `explore`: reads only (web, workspace reads, skill reads, read-only ace and connector tools).
     Every call it makes is a read, so it never needs the person;
   - `general`: the bot's own tools.
     Plugin agents (ADR 0151) add profiles: their text is the instructions, and a tool list in their
     frontmatter narrows the tools. A profile can name a model from the person's endpoints; otherwise
     the helper uses the bot's model. With no profile, `general`.
5. **A helper has less than its bot, never more.** No `helper` (helpers don't start helpers), no
   `ask_user`, no memory writes, no `skill_propose`, no `task_status` and no messages to other bots.
   It inherits the bot's autonomy level and allowed connectors and plugins. Its calls go through
   the same gate: one the gate would ask about appears in the bot's conversation as an approval
   naming the helper, and the person answers it there. "Always" answers apply to the bot, as now.
6. **Trust flows back.** A helper's result is untrusted if the helper read anything untrusted,
   so the bot's later writes in that turn ask, exactly as if the bot had read it itself.
7. **Limits.** 30 steps and $1 per helper, counted in the bot's daily and monthly caps and in the
   turn's cost shown to the person, but not in the bot's $2 turn limit. (Amended by
   [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md): no step count or spend of its own ends
   a helper; its cost still counts in the bot's caps and the turn's cost.) The result is cut to 20,000
   characters, like any tool's.
8. **What the person sees.** In the bot's conversation, each helper is one line, in Spade's words:
   "Helper looking into the build logs", then "Helper found …" or "Helper stopped". The line
   expands to the helper's own steps. No new panel, no new list.
9. **Bots on CLI brains** don't get `helper`: their CLI has its own way of splitting work.

## Consequences

- A long task keeps the bot's context for decisions; reading and searching happen in helpers.
- Independent parts of a task run side by side, within the bot's spending caps.
- Helpers add a kind of job and a hidden conversation kind; the conversation list leaves them out.

## Tests

- A bot with two helpers out reads as working until both results have arrived and its reply ends.
- A helper restarted mid-step resumes from its events and delivers its result once.
- Stop on the reply stops its helpers and starts no new reply from their results.
- An `explore` helper is never offered a write tool; a `general` helper's write asks in the bot's
  conversation, and the answer reaches the helper.
- A helper that read a web page returns an untrusted result: the bot's next write asks.
- A helper over $1 ends with that reason, and its cost counts toward the bot's daily cap.
  (Since ADR 0158: a helper takes as many steps as it needs; its cost counts toward the caps.)
