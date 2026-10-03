# ace

A multi-agent coding environment. ace drives the coding-agent CLIs you already have installed (Claude Code, Codex, OpenCode, Cursor, Antigravity) and gives them one interface on desktop, in the browser and on your phone.

Status: early development. The local daemon can store events and serve snapshots and replay over WebSocket. Provider execution and clients are still to come.

## How it fits together

- **Daemon** runs on the machine that has your code and your logged-in agent CLIs. It owns every agent process, the event log, git worktrees and terminals.
- **Clients** (desktop app, web app, mobile app) are views over the daemon's event log. They can connect locally or from another device.
- **Protocol**: every provider is translated into one canonical model. Agents form a tree, status is derived from the whole tree, and tool calls, approvals and background tasks are typed. See [docs/adr](docs/adr) and [docs/research/providers](docs/research/providers).

ace never asks for or stores your provider credentials. Each agent CLI uses the login you set up in that CLI.

## Repository layout

| Path                      | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `apps/relay`              | Self-hosted WebSocket relay with encrypted outbound host/client streams |
| `packages/secure-channel` | Portable Noise XX handshake, ordered transport and static identity      |
| `apps/daemon`             | Local SQLite event store and authenticated WebSocket server             |
| `packages/projection`     | Pure shared event folds for thread and sidebar views                    |
| `packages/git`            | Local Git worktrees, checkpoints, diffs and safe restore                |
| `packages/orchestrator`   | Multi-provider fan-out, races, pipelines and coordinator lanes          |
| `packages/review`         | Local diff comments, persistent anchors and structured agent fixes      |
| `packages/protocol`       | Canonical protocol: Zod schemas and types, no runtime logic             |
| `packages/agent-registry` | Official ACP catalog, approved local installations and source profiles  |
| `packages/provider-kit`   | Supervised provider processes, JSON-RPC, SSE and local CLI discovery    |
| `packages/workspace`      | Workspace file listing, reads, search and change subscriptions          |
| `packages/files`          | Streamed transfers, atomic workspace mutations, trash and artifacts     |
| `tools/recorder`          | Records raw provider sessions as fixtures for adapter contract tests    |
| `docs/adr`                | Architecture decision records                                           |
| `docs/research`           | Primary-source research behind the decisions                            |

The generated [protocol reference](docs/protocol/README.md) covers WebSocket messages, canonical events and built-in MCP tools. Regenerate it with `bun run docs:protocol`.

## Development

Requires Node 24+ and Bun 1.3+.

```sh
bun install
bun run check   # merge gate only: includes tests
bun run --filter @ace/daemon dev
```

Tests run in separate unit and process projects with bounded concurrency. See
[process test reliability](docs/testing/process-tests.md) for the real-I/O suite
inventory, shared fixtures and validation record. The owner requires tests to
run only at merge; development verification uses the permitted static checks.

The daemon prints its URL and token-file path. See [startup and degraded services](docs/daemon/startup.md) for readiness and service diagnostics. Remote access is off by default. See [remote access](docs/daemon/remote-access.md) for LAN/Tailscale pairing, device scopes and the `ace` CLI. See [store and sync](docs/daemon/store-and-sync.md) for configuration, the development creator, the command port, and replay behavior.

Local generic ACP launch and registry wire APIs are described in [agent registry](packages/agent-registry/README.md). Arbitrary agents retain unknown authentication and limited visibility; compatibility profiles are source-based until separately approved recordings establish behavior.

Remote access relay setup and APIs are described in [encrypted relay](docs/relay/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
