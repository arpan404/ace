# 0197: A Spade bot starts from one message and keeps its own task

Status: accepted. Date: 2026-11-19. Decided by: the owner (2026-11-19: "make the bot creation
experience better; e.g. the first message would be the bot's main task, and later the bot can also
edit it as the requirement changes."). Builds on [ADR 0126](0126-spade-agents.md) (agents and
their task), [ADR 0127](0127-spade-main-bot-and-chat.md) (the new-bot conversation),
[ADR 0128](0128-spade-memory.md) (what untrusted content may change),
[ADR 0154](0154-spade-questions-and-answering-later.md) (question cards),
[ADR 0163](0163-spade-auto-review-only.md) and [ADR 0171](0171-spade-decides-on-effects.md)
(who decides a call).

## Context

New bot was a conversation in name only: a face, a name field and a model line to settle before
the first message, which became the task word for word and never changed again unless the person
opened the profile. A task that grows in conversation ("also include Slack from now on") stayed
behind in the chat, and the bot's standing instructions drifted from what the person wanted.

## Decision

1. **One message makes the bot.** New bot asks "What should this bot do?" over the composer. What
   the person sends is the bot's task and its first message, in one call
   (`POST /v1/agents {task, naming: true, first_message}`). Templates are chips under the
   composer; model, machine and personality (tone, humour, emoji) are behind More settings, never
   required.
2. **The bot names itself.** A bot made with `naming` is "New bot" until its first reply, which
   is told to choose its name and face with `profile_update` before it answers. That first naming
   runs without asking while nothing untrusted is in view; it closes once the bot names itself,
   the person names it, or the first reply finishes (`naming_opened`, `profile_changed`). Any later
   change of its own name or face asks the person. The person renames it, or changes its face, in
   place from the chat's "Named itself" line or the profile.
3. **A capable new hire.** The standing scaffold (Spade's fixed instructions, not text an app
   shows) tells a bot whose conversation opens with its job to say the job back in one paragraph,
   how it will work and when it reports, ask at most three questions in one skippable card, name
   the apps it needs, offer a schedule as one question when the job recurs, and do the first piece
   of work when it can.
4. **The bot keeps its task.** `task_update {new_task, why}` rewrites the task when the person
   changes what they want for good. It applies from the next turn (the task sits in the prompt's
   cached top). Every task change is `agent_configured` with `change {by, previous, why}`, so the
   chat shows "Updated its task: …" with See change and Undo, and
   `GET /v1/agents/{id}/task/history` lists each version for the profile's Restore. The person's
   own edits record `by: person`.
5. **Injected text never rewrites instructions.** With anything untrusted in view (a page, an
   app's answer, a file, another bot's message, a tainted summary), a `task_update` goes to the
   person as a request with the before and after, in every access level; no "always" and no grant
   covers it. This is decided first, in `spade_core::self_edit::route`, before access levels.

## Consequences

- Two tools join every bot's offered list, so each existing conversation misses the cache once.
- The prompt says whose words the task is: "in the person's own words" or "as you last rewrote
  it at the person's request".
- The apps a task names show under its first name from the catalogue alone, behind one
  component (`SuggestedApps`); Spade's own fit replaces it when it lands.
- More settings carries the personality step (the personality settings that shipped in
  #2351), sent with the bot it makes.
