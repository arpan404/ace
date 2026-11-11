# Spade build plan to end to end

Date: 2026-11-10. "End to end" means: a person opens Spade in the ace desktop or web app, chats,
watches replies stream, steers or stops a turn, approves a write, sees Spade search the web, read a
page and use a skill from their ace library, and finds it all intact after restarting ace.

| Stream                                                                                                                                                                                                                                                                                                          | Owner                           | Where                              | Depends on         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------- | ------------------ |
| H. Harness core: tool calling in `spade-models`; `spade-core` registry, approval gate, step loop, steering, context layout, compaction planner; `spade-server` reply engine and API (chat-core.md) with the loop; built-in tools (`web_search`, `todo`, `ask_user`, `history_*`); `server.json`, lock and token | orchestrator                    | `spade/`                           | —                  |
| F. `spade-fetch`: `web_fetch` with SSRF protection and readable text                                                                                                                                                                                                                                            | child                           | `spade/crates/spade-fetch`         | —                  |
| B. `spade-ace`: MCP client of the daemon's endpoint, ace tools mapped to Spade tool definitions; `skills.request` client                                                                                                                                                                                        | child                           | `spade/crates/spade-ace`           | ace-integration.md |
| D. Daemon hosts Spade: process supervision, `spade.*` protocol family, credentials for Spade, setting to enable it, ADR                                                                                                                                                                                         | child                           | `apps/daemon`, `packages/protocol` | ace-integration.md |
| U. Spade in the ace web app: the rail's Spade place, conversations, streaming, composer with steer and Stop, approvals, endpoints and keys settings                                                                                                                                                             | child, after D's protocol lands | `apps/web`                         | D, H's API         |

Each stream merges to `main` through its own PR after review. Children run only the tests of
what they change: `cargo test -p <crate>` in `spade/`, or the Vitest files they touch; never
`bun run check` or the whole suite while several streams run at once.
