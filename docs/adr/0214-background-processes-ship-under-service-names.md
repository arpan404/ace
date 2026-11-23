# 0214: ace's background processes ship under service names

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: ace-media, ace-files and
ace-history show as "ace Media Service", "ace Files Service" and "ace History Service", and the
daemon as "ace Service", matching Electron's "ace Helper"; Windows adds `.exe`; Linux uses
hyphenated lower case).

## Context

Activity Monitor, Task Manager and `ps` showed ace's processes by their file names: `ace-media`,
`ace-files`, `ace-history`, and the daemon as `node`, since it runs on the bundled Bun runtime
installed as `bin/node` (`node.exe`). A person looking for what ace runs found a `node` they did
not start. The same runtime also runs every other ace script (the CLI, terminal guardians,
serve-sim, the MCP servers provider CLIs start), so renaming the runtime alone would show all of
those as the daemon.

Measured on macOS 27 (arm64): Activity Monitor (`proc_name`) shows the name of the file the
kernel executed. A hard link shows the link's name; a symlink shows its target's name; Bun
ignores `process.title`. `codesign` rewrites each name of a hard link as its own file, and zip and
DMG store both, so a signed app carries any second name as a full copy: the arm64 runtime is
88.7 MB (40.3 MB gzipped), against a 275 MB DMG and a 771 MB installed app. The standalone
archive's extractor, in every updater already installed, accepts only file and directory
entries, so an archive cannot carry a link either.

### What Bun 1.4.4 does differently when its executable is not named `node`

Measured with copies of the shipped runtime under both names (macOS arm64, and the Windows 11
ARM64 VM with the x64 desktop build), each probe run under `node` and `ace Service`:

| Behaviour                                                        | as `node`        | as `ace Service`          | Neutralised by               |
| ---------------------------------------------------------------- | ---------------- | ------------------------- | ---------------------------- |
| `.env`, `.env.local`, `.env.<NODE_ENV>` in the working directory | ignored          | loaded                    | `--no-env-file` (both OSes)  |
| first bare word (`install`, `run`, `test`)                       | a script path    | Bun's own command         | an absolute script first     |
| `--version`, no arguments                                        | "Missing script" | Bun's version, Bun's help | never passed                 |
| `bunfig.toml` in the working directory (`preload`)               | loaded           | loaded                    | Bun starts in its own folder |
| auto-install of a missing package without `node_modules`         | on               | on                        | same either way              |
| `NODE_OPTIONS=--require`                                         | ignored          | ignored                   | same either way              |
| `--` before the script's words                                   | passed through   | passed through            | same either way              |
| Windows: an add-on linked against `node.lib` (`descriptor.node`) | loads            | `LoadLibrary failed`      | delay-load hook (decision 3) |

Only the working directory's files are read, not its parents'. Real Node rejects
`--no-env-file` ("invalid negation"), so only the named runtime, which is always ace's own Bun,
gets the flag.

The `bunfig.toml` row was a hole before this decision: a `preload` in the folder `ace open` was
run from, or in the home a Linux user service runs in, ran its code in the daemon, under the
name `node` as much as any other, and `-c <file>` does not stop it. No flag turns it off, so
the runtime must not start in that folder.

## Decision

1. **One definition of the names.** `@ace/service/process-names` names each process per OS:
   `ace Media Service` on macOS, `ace Media Service.exe` on Windows, `ace-media-service` on
   Linux, and so on for files, history and the daemon (`ace Service`, `ace-service`).
2. **The Rust natives are renamed at staging.** Cargo packages and their development builds keep
   their names (`native/media/target/*/ace-media`); release and desktop staging copy the build
   into `media/`, `files/` and `history/` under the shipped name, and a release looks only for
   that name. Signing, entitlements, smoke and size checks take the names from the same module.
3. **The daemon runs on the runtime under its own name.**
   - The desktop app ships the runtime twice: `runtime/bin/node` and `runtime/bin/ace Service`
     (`runtime\ace Service.exe`), and starts only the daemon on the second, when it is a
     runnable file. One-shot commands run on the first.
   - A standalone release hard-links `bin/ace-service` (or `bin/ace Service`, `bin\ace Service.exe`)
     to `bin/node` the first time its supervisor or `ace open` starts the daemon: free, same bytes
     and signature. It does so only inside `<ACE_HOME>/releases/<release>/`, never in a Homebrew
     keg, an npm package or an app bundle, and accepts the name only while it is the same file as
     `bin/node` (same device and inode, or file index on Windows): a stale file is relinked by
     link-then-rename, a folder is left alone and the daemon runs as `node`.
   - Every named launch passes `--no-env-file` and an absolute entry script, so the table's
     differences do not apply (`daemonLaunches`). If the named runtime cannot be spawned, the
     same start falls back to the plain runtime with its old arguments.
   - At start the daemon points `process.execPath` back at the plain runtime beside it, so every
     child script it starts keeps the runtime's name, and logs both ("The daemon's runtime"). The
     Windows directory lease, which must bind libuv in the running image, reads that image's path
     from the loader (`GetModuleFileNameW`) instead.
   - Windows: `descriptor.node` delay-loads `node.exe` (`/DELAYLOAD:node.exe`) with a hook that
     answers with the running executable, so it binds to the one runtime in the process whatever
     its name. Measured on the VM: under `ace Service.exe` the add-on loads and its `statFd`
     reads a descriptor the runtime opened.
   - Bun starts in the entry script's own folder (`DaemonLaunch.cwd`), so it reads no `.env` or
     `bunfig.toml` from the caller's. `ace open` and the release supervisor pass their own
     working directory in `ACE_LAUNCH_CWD`, and the daemon entry's first import
     (`@ace/service/launch-directory-entry`, first in `tools/release/src/entry.ts` and
     `apps/daemon/src/cli.ts`) moves back into it before any other module runs, then removes the
     variable so no child inherits it. Every relative setting, model-instance folder, bare
     command, `:memory:` database, Windows drive-relative path and child's working directory
     keeps the exact meaning it had, with no per-setting code. If the folder is gone or refused,
     the daemon stays in its own and says so on stderr, without the path. The desktop app runs
     its daemon in the bundle's daemon folder, as it always did, and never passes the variable.
   - Foreground `ace start` and `ace serve`, run by hand through the `ace` launcher, stay on
     `node`: the launcher `exec`s the runtime for every command, and a person who runs the
     daemon in a terminal sees it there. The desktop app, the login service's supervisor and
     `ace open` start it as the service.
4. **Older layouts keep working.** A bundle without the named runtime starts the daemon on the
   runtime as before. Nothing finds ace's processes by name: stop and ownership checks use pids,
   lock ids and folder prefixes, which the rename leaves alone.

## Consequences

- The desktop download grows by the runtime's compressed size (about 40 MB on macOS arm64) and
  the installed app by its full size (about 89 MB). A Linux AppImage's squashfs deduplicates
  identical files, so it should store the copy once (not measured). Standalone releases and
  their daily updates cost nothing.
- On macOS and Windows desktop installs the daemon maps a different file from the runtime's other
  processes, so their code pages are no longer shared.
- Windows Firewall keys rules by executable path, so the desktop daemon's first LAN listen after
  this update may prompt again. Task Manager's Details tab and `Get-Process` show `ace Service`
  (measured). Its Processes tab names a process by the file's version-resource description,
  which `Get-Process` reports as "Bun" for the runtime copy; giving the copy and the Rust natives
  a description of their own is a follow-up.
- Package auto-install applies under either name, as before this decision, and is not changed
  here.
- Linux truncates `comm` to 15 characters: `top` shows `ace-history-ser`; `ps -f` shows the full
  name.
