# 0213: Each Spade role thinks at an effort the person picks

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: a thinking or reasoning
effort setting per model role, resolved like the role's model, with defaults main, review and
verify medium, helper, compact and title low). Amends [ADR 0162](0162-spade-model-routing.md);
its routing rules stand.

## Context

Spade sent no reasoning setting on any model call, so every bot's turns, the reviewer, the check
of done, helpers, summaries and titles ran at whatever each provider defaults to. That default
differs by provider and model: some think at length on every call, some never think unless asked.
A title paid for a long think; a review got none on a model that only reasons when told to. The
reviewer's 4,000-token limit (`REVIEW_TOKENS`) held both a model's thinking and its JSON answer,
so a model that thought hard cut its answer off.

The SDK Spade calls models through (`genai`) already turns one effort word into each format's
own setting. OpenAI-compatible endpoints differ in what they accept, and Spade's model facts
don't say which models reason (no preset lists the `reasoning` capability, and a listed model
never carries it), so the facts can't decide where to send it.

## Decision

1. **An effort per role.** `spade_models::Effort` is `provider` (send nothing), `off`, `low`,
   `medium`, `high` or `max`. Each role, `main` included, resolves it like its model: the bot's
   override, else the global one, else the role's default: `main`, `review` and `verify`
   `medium`; `helper`, `compact` and `title` `low`. It is stored in the same `model_roles`
   settings as the role's model (`efforts`), and read and set through the same
   `/v1/models/roles` and `/v1/agents/{id}/models` routes.
2. **On the prompt, sent on every call for the role.** `Prompt::effort` carries it, so there is
   no side channel: the bot's steps (a helper's as its bot's `helper` role), research, the
   reviewer, the verifier and replay comparisons, compaction, titles and digest polish. A
   compaction on the turn's own model thinks as the turn did, because a changed thinking setting
   misses the provider's cache. A `cli:` subscription (ADR 0133) runs its own sessions and is
   left alone.
3. **Room to think beside the answer.** A call that sets an answer limit gets `Effort::room` on
   top of it (2,048 tokens low, 9,216 medium, 25,600 high and max): above the largest Anthropic
   thinking budget for the effort, which must stay under `max_tokens`. The reviewer's 4,000
   tokens stay the answer's.
4. **Never fatal.** An endpoint that refuses a request carrying the setting (`400` or `422`,
   before any answer) is sent the same request once more without it. When that answers, the
   model is sent no effort again until Spade restarts. A request refused for another reason
   fails as before, and the effort is kept for the next call. A refused request is never
   billed, so the second try costs nothing.
5. **In the app.** Settings › Spade › Models for other work puts a thinking choice beside each
   role's model, plus a row for the bots' own turns; a bot's Details does the same under its
   models, each following Settings until set.

## Consequences

- A turn, review or check of done thinks at medium on every provider that supports it, and the
  cheap roles think little, whatever each endpoint's default.
- A scripted `400` in a test now sees two requests: the one with the effort and the one without.
- Learning a refusal costs one extra unbilled request per model per run of Spade; it is kept in
  memory only, so a provider that starts accepting the setting gets it after a restart.
- The ledger's estimates still read a call's answer limit without the room, so a high effort's
  estimate is low; billing uses the reported usage and is unaffected.
