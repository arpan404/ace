# 0133: Spade's bots can think with the person's subscriptions, through their CLIs

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: build "subscriptions
through your CLIs" end to end, as `spade/docs/design.md`, "CLI brains", planned). Builds on
[ADR 0002](0002-local-cli-providers.md), [ADR 0121](0121-the-daemon-hosts-spade.md) (its host thread),
[ADR 0123](0123-spade-runs-as-its-own-service.md), [ADR 0126](0126-spade-agents.md) and
[ADR 0127](0127-spade-main-bot-and-chat.md). The API is in
[spade/docs/cli-brains.md](../../spade/docs/cli-brains.md).

## Context

A Spade bot runs on a model from one of the person's endpoints, paid per token with their own
key (ADR 0119). Many people already pay for a subscription that comes with a coding-agent CLI
(Codex, Claude Code, OpenCode, Cursor, Antigravity, Pi) and ace already drives those CLIs as
provider sessions. ADR 0002 settles how ace may use a subscription: only through the person's own
installed, logged-in CLI, never by reading its login. So a bot that should think with a
subscription must run its turns as a provider session in the daemon, the one program that runs
those CLIs.

A CLI runs its own agent loop: it decides when to call tools, keeps its own context and can
resume a session. Spade's loop (harness.md) calls the model step by step and gates every tool
call. The two loops have to meet without the bot losing Spade's tools, memory, approval gate or
untrusted-content rules.

## Options considered

- **Read the CLI's login and call the provider's API from Spade.** Forbidden by ADR 0002.
- **Run the CLI from Spade.** Spade would duplicate the daemon's provider adapters, account
  homes, usage records and process supervision. Rejected: duplicate logic across packages is a
  bug.
- **A delegated child thread per turn.** Visible in the Threads panel, starts fresh each turn, and
  the person's bot would show as a pile of agent threads. Rejected.
- **Attach Spade's own MCP server to each provider session.** Needs a new extra-server path in
  every adapter (each CLI configures MCP servers its own way) and puts Spade's token in each
  CLI's configuration. Rejected for now.
- **Chosen:** one hidden provider session per bot in the daemon, resumed across turns, reached by
  Spade over its grant; the bot's own tools reach that session through two tools on ace's MCP
  endpoint, which every session already has, forwarded by the daemon to a small MCP server inside
  Spade.

## Decision

1. **A model may be a subscription.** A bot's model is `cli:<provider>/<model>` or
   `cli:<provider>@<account>/<model>`, with the provider and model ids as ace knows them and the
   account as ace's account id (no `/` or `@` in it). With no account the provider's default
   account runs it. The picker lists only what the daemon reports as installed, turned on and
   signed in, per account.
2. **One hidden session per bot.** The daemon keeps one thread per bot in Spade's hidden project,
   marked `host: "spade-bot"` with the bot's id, and resumes its provider session on every turn,
   so the CLI keeps its own context. Changing the provider or the account starts a new thread;
   changing the model inside a provider switches the model on the same thread. Like Spade's host
   thread, it is left out of every list, search and notification, and no client command may run
   an agent in it; only the daemon's brain service sends to it. It runs with read-only access in
   Spade's workspace folder, so the CLI's own edit and shell tools cannot change the person's
   files: everything the bot changes goes through Spade's gated tools or ace's tools.
3. **A turn is one streamed HTTP request.** Spade sends `POST <daemon>/spade/brains/turn` with its
   grant as the bearer. The daemon sends the message to the bot's session and streams what
   happens as JSON lines: text, a status line, and one end (finished with token counts, or failed
   with a reason). Spade closing the request before the end interrupts the CLI's turn: that is
   Stop, a pause for an update and Spade stopping. The first turn of a session, and any turn whose
   instructions changed, starts with Spade's instructions (rules, task, skill and memory indexes);
   every turn carries the new messages and their recalled notes. Messages sent while the CLI works
   are answered in a following turn of the same reply.
4. **The bot's tools come through ace's endpoint.** In a bot's session, ace's MCP endpoint offers
   `spade_tools` (the bot's tools with their schemas, found like `tool_search`) and `spade_call`
   (`{tool, arguments}`). Nowhere else are they offered. The daemon forwards both, with Spade's
   token, to Spade's MCP server for that bot (`/v1/agents/{id}/mcp`: `tools/list`, `tools/call`).
   Spade records each call as a step of the open reply and runs it through the same gate as an
   endpoint model's call: reads run, writes ask, destructive calls always ask, and a turn that
   read untrusted output asks for every write. The call waits for the person's answer; if the
   CLI gives up first, the result goes to the CLI with the next turn. Calls run one at a time.
   ace's own tools in that session are the session's own (ADR 0121's lease rules, `ask` withheld);
   `bots_list`, `bot_message`, memory, workspace, routines, skills, connectors and `ask_user` are
   Spade's.
5. **Failures are one line and never retried.** A CLI that is missing, signed out, rate-limited
   or out of quota ends the turn as failed with one plain line (for example "Codex is signed out.
   Sign in to it in ace, then send again."). The bot's roster row and conversation show it until
   a later turn works. Spade never retries a failed CLI turn and the daemon never switches the
   bot to another account.
6. **Usage stays with the subscription.** Token counts are recorded on the hidden thread, so they
   show in ace's usage display under that provider and account. Spade records the counts on its
   step with no cost, so CLI turns never count toward Spade's daily cap or per-turn cost limit,
   and those limits never stop them. Spade does not compact a CLI conversation; the CLI manages
   its own context.

## Consequences

- A bot can use the person's subscription with the same tools, memory and approvals as on an
  endpoint, and the person sees the same status and Stop.
- The bot's tools travel through the daemon, so a CLI bot needs both programs running; with ace
  away, its turn fails with one line, like a signed-out CLI.
- The CLI's own tools (web search, reading files in Spade's workspace) are not gated by Spade;
  read-only access keeps them from changing anything.
- Images sent to a CLI bot are described, not shown, until provider sessions take Spade's
  images.
- An extra MCP server per session, if a later change adds one to the adapters, can replace the
  forwarding without changing Spade's side.
