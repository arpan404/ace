# 0219: Spade bots never run on coding CLI subscriptions

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: "we don't support cli subs
bot at all, only thing we support cli is through ace projects and chat. No bot system should be
built on it. Login with chatgpt is different thing as here we hit the chatgpt oauth link with our
own harness."). Supersedes [ADR 0133](0133-spade-cli-brains.md). Amends
[ADR 0205](0205-spade-bots-think-with-models-the-person-controls.md) (sections 1, 2 and 4, and the
subscription rows of its tests). Builds on [ADR 0002](0002-local-cli-providers.md),
[ADR 0125](0125-validate-at-trust-boundaries.md) and
[ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md).

## Context

ADR 0133 let a Spade bot think with one of the person's coding subscriptions: the daemon kept one
hidden provider session per bot (`host: "spade-bot"`), ran each turn in the person's CLI, and
forwarded the bot's own tools through ace's MCP endpoint (`spade_tools`, `spade_call`). ADR 0205
kept it as an informed opt-in, with a terms record per provider and signed market notices that
could only tighten it.

The owner has decided that no bot system is built on a coding CLI. The person's CLIs are for what
ace does with them: projects, threads and chat. A bot that thinks with OpenAI through the person's
ChatGPT account is a different thing: Spade signs in with ChatGPT's OAuth itself and runs the bot
in its own harness (the provider accounts work, PR #2632), so it is a model endpoint like any
other, not a CLI.

## Decision

1. **Bots think only with model endpoints.** A bot's model is `endpoint/model` on one of the
   person's endpoints: an API key, a local model, or Spade's own provider sign-in. A
   `cli:<provider>[@<account>]/<model>` reference is never accepted for a new bot, a model change,
   a route, the fast model, the model for new bots or the speech model.
2. **What is removed.** Spade's CLI brain engine, its listing of subscriptions
   (`GET /v1/subscriptions`), the terms acknowledgement and record (`spade/config/cli-terms.json`,
   `cli_terms_ack:*`), the terms hold on a bot, the market's terms notices as Spade and the daemon
   use them, the daemon's brain routes (`/spade/brains/*`), its hidden bot sessions, the
   `spade_tools`/`spade_call` bridge, the adapters' bot-session hooks and the picker's "Your
   coding subscriptions" group. ace's coding-agent CLIs are untouched for projects, threads and
   chat.
3. **An existing bot on a subscription keeps working on an endpoint.** At setup, once its keys
   can be read, Spade moves each bot whose stored model is a `cli:` reference to the person's
   default model by ADR 0205's rule: the bot's `main` route, else the global one, then the first
   usable model. The bot keeps its conversation, its task, its memory and its settings. Its chat
   shows one plain line, stored as a `model_replaced` event (`from`, `to`, `line`): "Spade bots no
   longer think with coding subscriptions, so this bot moved from its Codex model to <model>."
   With no model to move to, the bot's model becomes none (`""`) and the line asks the person to
   pick one; the bot then waits for them as a new bot with no model does. A turn that starts
   before setup has moved it (or a reply an older build left open on a subscription) runs on the
   same replacement, chosen without reading keys.
4. **Old references read leniently, forever.** Events in history keep their `cli:` references
   (`reply_started`, `agent_configured`) and read as before; nothing rewrites history. A route an
   older build stored with a subscription in it skips that entry, as it skips any model no
   endpoint lists. A client shows an old reference as a model no endpoint offers.
5. **The work is bounded and lazy.** Setup's pass is one row update and one event per bot still on
   a subscription, bounded by the number of bots and never by history (ADR 0170). A bot it moved
   is never visited again.
6. **The daemon's old bot threads stay inert.** Nothing creates a `spade-bot` thread any more. One
   an older build left in Spade's hidden project stays there, out of every list as before: every
   command naming it is refused, and recovery never holds, resumes or replays it. They are not
   deleted: they sit in the hidden project beside Spade's other host threads, and a delete that
   picked the wrong thread would take the person's own work, so keeping a few inert rows is the
   safer cost. The protocol keeps `spade-bot` as a `host` value so their rows still read.

## Consequences

- A person who ran bots on a subscription now pays their endpoint for them, or runs them on a
  local model. The line in each bot's chat says what changed, once.
- Spade's paid plan and its tests were already independent of subscriptions (ADR 0205 §5); they
  stay so.
- The market Worker's signed terms notices (`GET /v1/notices`, the signer's `notices` list) are
  left in place for now: no build reads them any more, and removing them waits for a Worker deploy.
- An organization policy's `models.subscriptions` flag no longer has anything to allow; shared
  bots were already refused subscriptions.

## Tests

- A bot an older build left on `cli:codex@work/…` moves at setup to the default model, keeps its
  conversation, answers its next message on the new model, and shows one `model_replaced` line;
  a later start moves nothing.
- `POST /v1/agents` and `PATCH /v1/agents/{id}` with a `cli:` model answer 400; a route with one
  is refused, and one stored by an older build is skipped.
- A command on a `spade-bot` thread is refused, whoever sends it.
- The chat folds `model_replaced` into one quiet line.
