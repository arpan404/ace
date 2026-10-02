# ace

A multi-agent coding environment. ace drives the coding-agent CLIs you already have installed (Claude Code, Codex, OpenCode, Cursor, Antigravity) and gives them one interface on desktop, in the browser and on your phone.

Status: early design. Nothing here is usable yet.

## How it fits together

- **Daemon** runs on the machine that has your code and your logged-in agent CLIs. It owns every agent process, the event log, git worktrees and terminals.
- **Clients** (desktop app, web app, mobile app) are views over the daemon's event log. They can connect locally or from another device.
- **Protocol**: every provider is translated into one canonical model. Agents form a tree, status is derived from the whole tree, and tool calls, approvals and background tasks are typed. See [docs/adr](docs/adr) and [docs/research/providers](docs/research/providers).

ace never asks for or stores your provider credentials. Each agent CLI uses the login you set up in that CLI.

## Repository layout

| Path                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `packages/protocol` | Canonical protocol: Zod schemas and types, no runtime logic          |
| `packages/git`      | Local Git worktrees, checkpoints, diffs and safe restore             |
| `tools/recorder`    | Records raw provider sessions as fixtures for adapter contract tests |
| `docs/adr`          | Architecture decision records                                        |
| `docs/research`     | Primary-source research behind the decisions                         |

## Development

Requires Node 24+ and Bun 1.3+.

```sh
bun install
bun run check   # format check, lint, typecheck, tests
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
