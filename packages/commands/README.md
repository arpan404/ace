# Commands and prompts

`@ace/commands` supplies one backend catalog for every client's slash palette.
See [ADR 0039](../../docs/adr/0039-commands-and-prompts.md).

`CommandLibrary` takes trusted thread contexts, explicit provider instance homes,
an ace home and a clock. It loads each workspace and instance lazily. Eight
contexts are retained; contexts with runtime catalogs stay pinned until their
sessions clear them. `list` returns metadata; `resolve` returns a plan and never
sends it. Consumers submit prompt plans verbatim and send native plans through
the provider command transport. This keeps slash text inside snippets literal.
Call `recordUse` after execution to rank by frequency and recency.
Usage statistics are bounded and kept in memory for the daemon's lifetime.

Adapters feed `updateRuntime(threadId, frame)` with the Claude system init or the
ACP `available_commands_update` body. Call `clearRuntime(threadId)` on session
close. Clearing also cancels updates that are still pending. The lower-level `CommandCatalog` has the same runtime port with an
explicit target. Unknown provider metadata remains on native execution plans.

The daemon exposes authenticated `commands.list` and `commands.resolve` messages
outside its mutation receipt envelope. Both require read scope. The normal
startup service uses registered workspace paths and CLI config home overrides.
The optional `DaemonCommandIntegration` startup argument accepts `instances`,
`instanceForThread` and a local `CommandEventSource`. Its `commands.runtime`,
`session.closed` and `command.executed` events feed runtime catalogs, clear
sessions and record successful execution usage. Source handlers return promises
so the engine can observe errors or apply backpressure. These are trusted local
events; remote socket clients cannot report execution or choose filesystem homes.
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
2,048 sources, 4,096 commands, 4,096 discovery nodes, 8,192 queued jobs,
32 open directory cursors and 32 pinned trusted-root descriptors per context,
128 native watchers, 256 pending invalidations, 16 service requests and 1,024
usage records. Oversized files and malformed frontmatter produce diagnostics.
Full catalogs reject new sources.

Directory changes enumerate names without rereading surviving files or walking
unchanged subdirectories. Generation marks find removals without copying the
child index. Enumeration and subtree removal advance in 32-unit turns. Recovery
checks up to 32 metadata records and advances one discovery turn per tick.
`reconcile` runs one tick; explicit `flush` and initial `start` drain all queued
work. `metrics()` reports body read work and metadata/enumeration counts.
Missing directories are watched through existing ancestors. Native watcher loss
and watcher admission limits leave metadata recovery active.

The secure I/O shell uses asynchronous descriptor-relative POSIX operations
through Koffi on 64-bit macOS/Linux x64 and arm64. Every opened component rejects
symlinks. Body reads use the opened file descriptor. A pinned anchor retains its
directory identity for the context lifetime; reopen the context after changing
a registered workspace or provider home. Other platforms need a secure injected
`CommandFileIo`; discovery never falls back to pathname-only validation.
Startup is idempotent. `close` drains startup/work and releases directory cursors,
watchers, recovery timers and root descriptors. Tests inject filesystem timing,
notification sources and scheduling without replacing actual file contents.

Behavior tests and benchmark execution are deferred to merge time under the
repository owner's current validation policy. The non-gating benchmark in
`bench/catalog.ts` measures source replacement, resolution, fuzzy ranking,
metadata recovery, incremental file refresh and directory churn.
