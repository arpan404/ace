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
     (`runtime\ace Service.exe`), and starts only the daemon on the second. One-shot commands
     run on the first.
   - A standalone release hard-links `bin/ace-service` (or `bin/ace Service`, `bin\ace Service.exe`)
     to `bin/node` the first time its supervisor or `ace open` starts the daemon: free, same bytes
     and signature. It does so only inside `<ACE_HOME>/releases/<release>/`, never in a Homebrew
     keg, an npm package or an app bundle; where it cannot, the daemon runs as `node`.
   - At start the daemon points `process.execPath` back at the plain runtime beside it, so every
     child script it starts keeps the runtime's name. The Windows directory lease, which must
     bind libuv in the running image, reads that image's path from the loader instead.
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
  this update may prompt again. Task Manager's Processes tab prefers a file's version-resource
  description to its name; what it shows for these files is not yet checked on Windows.
- Linux truncates `comm` to 15 characters: `top` shows `ace-history-ser`; `ps -f` shows the full
  name.
