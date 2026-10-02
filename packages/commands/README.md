# Commands and prompts

`@ace/commands` supplies one backend catalog for every client's slash palette.
See [ADR 0039](../../docs/adr/0039-commands-and-prompts.md).

`CommandLibrary` takes trusted thread contexts, explicit provider instance homes,
an ace home and a clock. It loads each workspace and instance lazily. Eight
contexts are retained; contexts with runtime catalogs stay pinned until their
sessions clear them. `list` returns metadata; `resolve` returns a plan and never
sends it. Call `recordUse` after execution to rank by frequency and recency.
Usage statistics are bounded and kept in memory for the daemon's lifetime.

Adapters feed `updateRuntime(threadId, frame)` with the Claude system init or the
ACP `available_commands_update` body. Call `clearRuntime(threadId)` on session
close. The lower-level `CommandCatalog` has the same runtime port with an
explicit target. Unknown provider metadata remains on native execution plans.

The daemon exposes authenticated `commands.list` and `commands.resolve` messages
outside its mutation receipt envelope. Both require read scope. The normal
startup service uses registered workspace paths and CLI config home overrides.
`startDaemon` returns its command library for adapters. Account integrations can
inject a `CommandLibrary` into `startServer` with their own thread-to-instance
registry. Built-in ace action plans must be dispatched by the modules that own
their behavior.

Provider command files remain native to their provider. Codex prompt files expand
locally because its app-server does not expand TUI slash commands. Codex user
prompts are top-level only; project `.codex/prompts` is an ace extension. OpenCode
supports JSON, JSONC and both `command` and `commands` directories. Claude skills
load from `skills/<name>/SKILL.md`, including named frontmatter.

An ace snippet at `<ace home>/prompts/explain.md` or `.ace/prompts/explain.md`:

```markdown
---
name: explain
description: Explain a file
provider: any
arguments:
  file:
    type: string
    required: true
  detail:
    type: number
    default: 3
---

Explain {{file}} at detail level {{detail}}.
```

Named arguments arrive as a typed object, such as `{file: "app.ts"}`. Escape a
literal placeholder with `\{{file}}`. Defaults must match their declared type.
Inserted values are literal and are never expanded again. Unknown arguments and
undeclared placeholders produce errors. Library templates leave provider dollar
syntax literal; Codex files support `$ARGUMENTS`, `$1` through `$9`, `$NAME` and
`$$` for a literal dollar.

Project files override user files inside each namespace. Runtime commands override
provider files. Provider, ace and snippet names can coexist; use IDs for selection.
Another account's commands never appear in an active thread's palette.

Limits include 64 KiB per file, 8 MiB estimated retained definitions per catalog,
2,048 sources, 4,096 commands, 8,192 discovered paths, 128 nonrecursive directory
watchers per context, 256 pending invalidations, 16 service requests and 1,024
usage records. Oversized files and malformed frontmatter produce diagnostics.
Full catalogs reject new sources. Watcher limits leave affected directories
available to explicit `invalidate`/`flush` refresh. Missing directories are
watched through existing ancestors. Call `close` to dispose the service.

Run focused tests with `bun run test packages/commands/src -- --maxWorkers=2`.
`bun run --filter @ace/commands bench` measures source replacement, resolution,
fuzzy ranking and incremental file refresh. It is not a test gate.
