# @ace/plugins

Install a capability package once and prepare provider-native session configuration. Nothing in this package starts a provider, hook or MCP server.

## Manifest

An `ace-plugin.json` example:

```json
{
  "schemaVersion": 1,
  "name": "team-tools",
  "version": "1.0.0",
  "skills": [{ "name": "review", "path": "skills/review" }],
  "commands": [{ "name": "check", "path": "commands/check.md" }],
  "agents": [{ "name": "reviewer", "path": "agents/reviewer.md" }],
  "rules": [{ "name": "conventions", "path": "rules/conventions.md" }],
  "mcpServers": {
    "tools": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/scripts/server.js"],
      "env": { "MODE": "local" }
    }
  },
  "hooks": [
    {
      "event": "SessionStart",
      "command": "node \"${PLUGIN_ROOT}/scripts/session.js\""
    }
  ]
}
```

Skills must contain `SKILL.md`. Commands and agents are Markdown definitions; preserve native frontmatter when Claude or Cursor needs it. Rules provide unconditional guidance. Component paths are relative to the plugin root, with an optional `./` prefix. Stdio MCP working directories are relative paths too. Command arguments and environment values are data, with plugin-root placeholders expanded by the projector. Shell hook placeholders use the provider's native root variable and retain authored quoting.

The importer also accepts Agent Plugins 1.0 fixed locations, Claude layouts with default or custom component paths, and the practical shared subset of Codex and Cursor compatibility manifests. It reports unsupported capabilities. See [ADR 0014](../../docs/adr/0014-plugins.md) for the mapping and limits of that compatibility.

## Marketplaces and consent

A Git repository contains `marketplace.json`:

```json
{
  "name": "team",
  "plugins": [{ "name": "team-tools", "source": "./plugins/team-tools" }]
}
```

Entries may set `hash` to the expected content SHA-256. The same repository's commit pins all directory entries. `source: "./"` packages the repository root. Claude and Cursor catalog locations are accepted as fallbacks; remote entry sources and install scripts are not interpreted.

```ts
import { randomUUID } from "node:crypto";
import { PluginManager } from "@ace/plugins";

const manager = await PluginManager.open({
  root: "/absolute/canonical/path/to/ace/plugins",
  now: Date.now,
  id: randomUUID,
});
const review = await manager.prepare({
  repository: "https://github.com/example/team-tools.git",
  ref: "main",
  name: "team-tools",
});
```

Display `review.executions`, including exact hook commands, MCP command/argv/env/cwd and remote endpoints. Also display the commit, hash and unsupported diagnostics. Root placeholders in the review identify immutable plugin resources; a session projection maps them to its owned payload directory.

After consent, call `manager.accept({id: review.id, commit: review.commit, hash: review.hash})`. `manager.update(name)` returns another review and leaves the installed version unchanged until acceptance. Even a script-only change behind the same version and command requires consent again. `cancel(id)` removes a pending review, `pending()` recovers reviews after reconnect, and `remove(name)` drops the accepted installation and its pending reviews. Close the manager on shutdown.

The root must be empty on adoption or have a valid ace ownership marker. Use canonical absolute paths with no symlink ancestors. All mutations acquire a separate SQLite transaction lock; competing operations fail with `Plugin manager busy`, allowing the daemon to retry through its command owner. Crashes release the lock. Restart and successful mutations remove orphaned versions, staging directories and fetches.

## Adapter integration

```ts
import { projectPlugins, materializeProjection } from "@ace/plugins";

const installed = await manager.installed(); // rechecks content and executable bits
const root = "/absolute/canonical/path/to/ace/session-123/plugins";
const projection = projectPlugins("claude", installed, { root });
await materializeProjection(projection, { root });
// Pass projection.env and projection.args to the adapter's process boundary.
// Pass projection.sessionConfig to ACP session setup.
```

Show `unsupported` before starting the provider. A provider may require native hook trust after ace's review. Never disable provider approval policies to make a plugin run. Probe the installed CLI for supported flags and ACP transports. The package deliberately does not spend subscription quota to probe session behavior.

| Provider          | Native output                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude            | `--plugin-dir`, skill resources, commands, agents, command hooks, `--mcp-config`, appended instruction file                                  |
| Codex             | Local marketplace and enablement through `-c`, native plugin skills and bundled hooks, TOML MCP overrides, additional developer instructions |
| OpenCode          | Inline config with extra skill directories, commands, subagents, instruction paths and local/remote MCP                                      |
| Cursor            | `--plugin-dir` with skills, commands, agents, unconditional rules, MCP and native command hooks                                              |
| ACP / Antigravity | Session MCP configuration; file capabilities report unsupported                                                                              |

Codex custom slash commands and portable Markdown subagent definitions report unsupported. OpenCode hooks, OpenCode MCP `cwd`, ACP MCP `cwd`, unsupported hook events and Codex SSE MCP also report unsupported. Hook event names can map across clients, but scripts must account for native input/output contracts.

Create one projection root per session. Do not replace or remove it while its provider is running. `materializeProjection` verifies streamed source copies before swapping the generated tree and removes obsolete output. `removeProjection(root)` deletes the generated tree after session shutdown. It retains the ownership marker and lock database so the root can be safely reused. The daemon should remove the session root when it removes the rest of that session's owned files.

`PluginService.handle(unknown)` validates prepare, update, accept, cancel, remove and list requests against `@ace/protocol/plugins`. It is ready for the daemon command owner to mount. The current WebSocket dispatcher is unchanged; command receipts and authorization remain its responsibility.

## Bounds and verification

JSON documents are capped at 256 KiB, individual files at 4 MiB, selected package bytes at 32 MiB and selected files at 2,048. There are at most 256 accepted plugins and 32 pending reviews. Projection can copy resources into both payload and native skill directories, so generated files and bytes have separate caps. Overrides are capped at 64 KiB per argument/environment value and 128 KiB combined. Larger collections fail explicitly and must be selected in smaller groups.

Content hashing streams 64 KiB chunks. The package digest hashes sorted newline-framed JSON tuples of `[relativePath, bytes, executable, fileSha256]`. Git extraction reads blobs through capped streams, preserves executable bits, and rejects symlinks, submodules, path traversal and special files. It never checks out files or runs filters. Git fetch is shallow, config-isolated and time-bounded, but its external pack download needs host disk quotas for untrusted remote repositories. Private repositories need Git access that works without an interactive credential helper; ace does not collect credentials.

Run `bun run test -- packages/plugins/src` for behavior tests and `bun run --filter @ace/plugins bench` for the non-gating benchmark. Tests use local Git repositories and temporary SQLite, never provider sessions. See [MUTATIONS.md](MUTATIONS.md) for deliberate faults caught by the suite.
