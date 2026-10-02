# ace

A multi-agent coding environment. ace drives the coding-agent CLIs you already have installed (Claude Code, Codex, OpenCode, Cursor, Antigravity) and gives them one interface on desktop, in the browser and on your phone.

Status: early development. The local daemon can store events and serve snapshots and replay over WebSocket. Provider execution and clients are still to come.

## How it fits together

- **Daemon** runs on the machine that has your code and your logged-in agent CLIs. It owns every agent process, the event log, git worktrees and terminals.
- **Clients** (desktop app, web app, mobile app) are views over the daemon's event log. They can connect locally or from another device.
- **Protocol**: every provider is translated into one canonical model. Agents form a tree, status is derived from the whole tree, and tool calls, approvals and background tasks are typed. See [docs/adr](docs/adr) and [docs/research/providers](docs/research/providers).

ace never asks for or stores your provider credentials. Each agent CLI uses the login you set up in that CLI.

## Repository layout

| Path                    | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `apps/daemon`           | Local SQLite event store and authenticated WebSocket server          |
| `packages/projection`   | Pure shared event folds for thread and sidebar views                 |
| `packages/git`          | Local Git worktrees, checkpoints, diffs and safe restore             |
| `packages/protocol`     | Canonical protocol: Zod schemas and types, no runtime logic          |
| `packages/provider-kit` | Supervised provider processes, JSON-RPC, SSE and local CLI discovery |
| `tools/recorder`        | Records raw provider sessions as fixtures for adapter contract tests |
| `docs/adr`              | Architecture decision records                                        |
| `docs/research`         | Primary-source research behind the decisions                         |

## Development

Requires Node 24+ and Bun 1.3+.

```sh
bun install
bun run check   # format check, lint, typecheck, tests
bun run --filter @ace/daemon dev
```

The daemon prints its URL and token-file path. See [store and sync](docs/daemon/store-and-sync.md) for configuration, the development creator, the command port, and replay behavior.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
