# 0126: Spade is a set of agents, each with one conversation, on models the person picks

Status: accepted. Date: 2026-11-11. Decided by: the owner (2026-11-11: "one agent has one
conversation and we should be able to have multiple agents on one computer. When the user first
sees it, they create an agent: name, task/description and avatar", and "I should be able to choose
the model properly instead of predefined" ones). Builds on [ADR 0119](0119-spade-endpoint-keys.md)
and [ADR 0123](0123-spade-runs-as-its-own-service.md); replaces the "Crews" sketch and the shipped
model roles in `spade/docs/design.md`.

## Context

Spade shipped as one assistant with a list of chats, like a chat app: every "new chat" started an
empty conversation on the model the shipped `spade/config/models.json` named for the `main` role.
The person could add keys only for the endpoints that file lists and could only use the models it
lists. The first real use (2026-11-11) showed both limits at once: the person wanted their own
model, and wanted lasting assistants with a job, not throwaway chats.

Spade's harness already keeps one conversation going indefinitely (steering, background jobs,
automatic compaction, restarts), and runs many conversations at once, so an agent that is one
long conversation needs no new engine.

## Options considered

- **Keep chats, add a model menu.** Fixes the model limit only; the person still re-explains the
  job in every chat.
- **Agents with many chats each.** More to build and to show, and splits what an agent knows
  across chats; compaction already makes one conversation last.
- **Chosen:** agents, each exactly one conversation, any number per machine, each on a model the
  person picks from their own endpoints.

## Decision

1. **An agent is a name, a task, an avatar and a model, with exactly one conversation.** The
   name is 1 to 40 characters. The task (what the agent is for, in the person's words, up to
   4,000 characters) is the agent's instructions, placed in the cached top of its prompt. The
   avatar is an image the person uploads (stored once by hash, like attached images) or a
   generated one (initials on one of a fixed set of colours). There is no "new chat": the agent's
   one conversation is created with it and lives as long as it does; compaction keeps it within
   the model's context.

2. **Many agents per machine, independent.** Each runs, steers, stops, compacts and recovers on
   its own, concurrently, as conversations do today. Stop, approvals and background jobs belong to
   one agent.

3. **First run is creating an agent.** With no agents, Spade's screen is the creation form: name,
   task, avatar, model. Afterwards the sidebar lists agents (avatar, name, last activity) with a
   "New agent" action; opening one shows its conversation.

4. **Editing takes effect at the next turn.** Name and avatar change at once. A changed task or
   model is stored as an event and used from the agent's next turn, never mid-turn, so a restart
   rebuilds the same prompt; the change costs one cache miss. Deleting an agent deletes its
   conversation, after the person confirms.

5. **Endpoints and models are the person's.** The person adds endpoints (name, one of the three
   formats, base URL, optional extra headers; the key goes to the OS keychain as ADR 0119 says).
   Models come from the endpoint's own model list (`GET <base>/models`), searchable, and any model
   id can also be typed in. Context size and capabilities come from the endpoint's answer where it
   gives them, else from the shipped file when the id is known there, else defaults the person can
   edit. The shipped `models.json` becomes presets (endpoint templates and known model facts), not
   the list of what may be used. The person's endpoints and models are stored in Spade's database;
   keys never are.

6. **Side jobs use a fast model the person sets.** Titles and other small jobs use the person's
   chosen fast model, or the agent's own model when none is set. Compaction keeps using the
   agent's own model, as before.

7. **Endpoints that route by session get one.** An endpoint may name a session header (the
   OpenCode Go preset uses `x-opencode-session`); Spade sends a stable id per agent conversation
   in it. Every model request identifies Spade in its User-Agent (`spade/<version>`).

8. **Existing conversations become agents.** On upgrade each stored conversation becomes an agent
   named after its title, with an empty task, a generated avatar and the previous main model, so
   nothing is lost.

## Consequences

- The person can use any model any of their endpoints serve, including local ones.
- An agent remembers its job across days without re-explaining; long agents rely on compaction,
  so recalling exact old text needs `history_search`/`history_read` (not yet built).
- Spade's API gains agents and endpoint/model management; the conversation routes stay for the
  events and live stream of an agent's conversation.
- Model metadata may be wrong for models nobody describes (context, images); the defaults are
  conservative and editable.
- The web app's Spade screens change from chats to agents; iOS follows when Spade ships there.

## Tests

- Store: an agent and its one conversation are created together; migrating existing
  conversations yields one agent each with nothing lost.
- Engine: two agents stream at once; Stop on one leaves the other running; a task or model change
  applies from the next turn and survives a restart with the same prompt.
- Models: a fake endpoint's model list is offered; a typed model id works; the session header
  carries the same id on every request of one agent and differs between agents.
- Web: first run shows the creation form; creating an agent opens its conversation; the model
  picker lists the endpoint's models and accepts a typed id.
