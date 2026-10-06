# Native ace MCP verification, 2026-10-05

The sandbox used the worktree daemon with a temporary ace home and a throwaway
`/tmp` git workspace. The installed provider CLIs used their existing login.
Browser, screen and device catalogs came from the daemon; screen/device I/O used
the offline helper backends. Prompts only requested native tool names and a
read-only `ace_thread_info` call. No fast mode was enabled and no owner's project
was opened. The installed desktop app and `~/.ace-next` were not modified.

| Provider    | Installed version / model                         | Prompts | Native evidence                                                                                                  |
| ----------- | ------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenCode    | 2.0.22 / `opencode-go/muse-spark-1.3-contributor` | 2 of 10 | Native catalog `ace: connected`, direct `ace_ace_thread_info` success, browser/screen/device/agent tools listed. |
| Codex       | 0.159.1 / `gpt-6.1-sol`                           | 1 of 5  | `mcpServer/startupStatus/updated` ready; native `mcpToolCall` for `ace_thread_info` completed.                   |
| Claude Code | 2.1.286 / `claude-opus-5-5`                       | 1 of 5  | Native catalog via SDK init/ToolSearch; `mcp__ace__ace_thread_info` invocation and result.                       |
| Cursor CLI  | 2026.10.01-e373342 / `composer-2.5`               | 2 of 5  | Native MCP catalog discovery and `mcpToolCall` success using a temporary plugin outside the workspace.           |

OpenCode's first prompt used an empty native database and failed `provider.no-route`;
its login is held in the native SQLite database. The successful run used a
copy-on-write clone of that database and WAL, allowing provider writes exclusively
to the sandbox clone. No provider credential was decoded or exported. The clone
was deleted after verification. Before the fix, v1 injection returned an empty
native MCP catalog even while config inspection displayed the supplied server.
V2's runtime registration API loaded the catalog before the first prompt.

Cursor's launcher updated from 2026.09.26-dd393fe to the version above. Its first
run discovered the native catalog but rejected execution under CLI tool approval;
the second used `--force` in the throwaway workspace and succeeded. CLI verification
uses a temporary plugin's HTTP `mcpServers` configuration, identical to the SDK
HTTP transport object. It does **not** establish a live SDK login: ace's default
SDK backend uses its own instance login. The daemon SDK regression runs the public
SDK boundary against the real daemon and validates all tool groups without a paid
prompt. Cursor ACP is covered separately by the negotiated-session regression;
the current installed Cursor CLI no longer exposes `--acp`.

Pi and generic/Antigravity ACP received offline native session/extension coverage,
not additional paid turns. ACP HTTP input is validated against SDK 1.7.0's published
schema. Claude's config passes through SDK 0.3.287, and Cursor's through SDK 1.0.35.
The provider process regressions exercise actual daemon tool effects and check
that inherited provider env/argv contain no bearer. The private-file reader also
checks owner, permissions, regular-file type, size, and refuses symlinks.

Redacted recordings are `fixtures/{opencode/2.0.22,codex/0.159.1,claude/2.1.286,cursor/2026.10.01-e373342}/native-ace-mcp.jsonl`.
They were imported with `tools/recorder/src/import-native-mcp.ts`. That importer
starts no provider and spends no quota. Frame order is preserved; timestamps are
import timing, and the header timestamp is the capture file's modification time.
Recordings are evidence of native discovery/execution, not latency benchmarks.

Schema fixtures retain only the native MCP subtree and referenced definitions.
References are normalized to local `$defs` for Zod's JSON Schema reader:

- OpenCode: installed 2.0.22 `/openapi.json`, `Config.InfoEncoded.properties.mcp`.
  [Remote config and Code Mode documentation](https://dev.opencode.ai/v2/docs/mcp-servers/).
- Codex: [0.159.1 config schema](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/core/config.schema.json),
  `RawMcpServerConfig`.
- ACP: installed `@agentclientprotocol/sdk` 1.7.0 exported `schema/schema.json`,
  `McpServerHttp`.

Read-only analysis of a temporary copy of the owner's event database found an
OpenCode network retry carrying `ECONNRESET` and attempt 2. No MCP failure in the
available daemon log explained that banner. The translator regression distinguishes
model retries from MCP tool failures; the UI's existing network status is accurate.
