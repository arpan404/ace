# @ace/terminal

POSIX PTY sessions owned by the local daemon. This package has no client UI or daemon transport wiring. `node-pty` is its only direct runtime dependency.

## API

```ts
import { TerminalManager } from "@ace/terminal";

const manager = new TerminalManager({
  scrollbackBytes: 4 * 1024 * 1024,
  graceMs: 1000,
});
const terminal = manager.openTerminal({
  cwd: "/path/to/workspace",
  cols: 80,
  rows: 24,
  name: "workspace shell",
  // shell: "/bin/bash",
  // env: { EXAMPLE: "value", REMOVE_INHERITED: undefined },
});

const attachment = terminal.attach({ fromOffset: 0 });
for await (const event of attachment) {
  if (event.type === "data") {
    // Send event.data to the terminal renderer. Save event.endOffset as the cursor.
  } else if (event.type === "resync") {
    // Clear the renderer and attach again from event.oldestOffset.
  } else {
    // event.status is { code, signal }. All retained output preceded this event.
  }
}

terminal.write("echo hello\r");
terminal.resize(120, 40);
await terminal.kill("SIGTERM");
const status = await terminal.exited;
const snapshot = terminal.snapshot();
await manager.closeAll();
```

The iteration above is a separate consumer task in a real integration. Call `attachment.detach()` to cancel a pending read, or break from its `for await` loop. Neither operation affects the PTY or another watcher. Permit only one outstanding `next()` per attachment.

`name` is a display label. The terminal type is always `xterm-256color`; `COLORTERM` is always `truecolor`, even if `env` overrides them. Other environment values override the daemon's environment; `undefined` removes an inherited value. Environment values are not included in snapshots.

The shell is the explicit `shell`, otherwise the daemon's `$SHELL`, otherwise the first executable of `/bin/zsh` and `/bin/bash`. It runs with `-l -i` and reads the user's normal startup files. An explicitly configured shell that cannot launch fails rather than silently selecting another shell. Dimensions must be positive safe integers. The narrow internal `PtyBackend` interface owns native output, input, resizing and process-group termination; a future ConPTY backend can implement it without changing scrollback or attachments.

## Offsets and bounded memory

Offsets count raw output bytes starting at zero, including terminal escape sequences and CRLF. Data events carry `offset`, exclusive `endOffset`, UTF-8 `data`, and `truncatedBefore`. Always persist `endOffset` rather than deriving it from JS string length.

Each terminal allocates one byte ring, default 4 MiB, configurable on the manager with a minimum of four bytes. Every PTY read goes straight into it. Attachments keep a cursor and at most one pending read; there is no per-reader output queue. Delivery chunks contain at most 64 KiB of source bytes. Callers own the events they consume and must bound their own socket queues.

`attach()` starts at the current oldest retained byte. An explicit offset behind the ring starts at its oldest complete character and sets `truncatedBefore` on the first data event only. An offset inside a character advances to the next character and also sets that flag. Negative, fractional or future offsets throw.

If a cursor is overwritten after attachment, its next read receives `resync` with the current `oldestOffset` and `nextOffset`, then the iterator ends. Re-attach from `oldestOffset` to replay the retained tail. Resync delivery is pull-based; a watcher that stops reading keeps no output queue. The PTY continues draining when some, all, or no watchers read.

Incomplete UTF-8 suffixes stay in the raw ring until their remaining bytes arrive. Complete characters are never divided across delivery chunks. Invalid source bytes and an incomplete suffix at exit decode with replacement characters, while offsets still count the original bytes. A raw snapshot preserves those bytes exactly.

## Shutdown and persistence

`closeAll()` permanently closes the manager and is idempotent. It collects the shell's descendant process groups through POSIX `ps`, sends SIGTERM to each group, waits the configured grace period, sends SIGKILL to surviving groups, and waits until those groups have no running members. A zombie awaiting OS reaping is already stopped. Job-control background groups are included, and captured groups remain targets if the shell exits first. Errors are aggregated after every terminal has been attempted. `kill(signal)` also targets the shell and its current descendant groups.

This is process supervision, not process isolation. Processes that detach, or outlive a naturally exited shell and become reparented before discovery, are outside this ancestry-based ownership model. A naturally exited shell retains its scrollback and status; it is not restarted. Terminal handles reject writes and resize after exit or during shutdown.

`snapshot()` returns JSON-safe versioned metadata, dimensions, capacity, raw byte offsets, base64 retained bytes and the retained exit status. A snapshot may start inside a UTF-8 character or end with an incomplete one. Restore consumers must align/decode it as described above. Snapshot loading and restarting live shells are left to future daemon work. The manager retains terminal handles for its lifetime; discard the manager to release those rings.

## Native installation and Electron

From the repository root, run `bun install`. Root `trustedDependencies` allows node-pty's install hooks. Upstream selects its bundled native binaries when available and runs `node-gyp` otherwise. Compilation requires a C++ toolchain and Python; on macOS install Xcode command-line tools, and on Linux install Python, make and a C++ compiler. See the [node-pty build instructions](https://github.com/microsoft/node-pty#dependencies).

node-pty 1.1.0's macOS tarball contains a non-executable prebuilt spawn helper. The root postinstall runs this package's `prepare-native` script to set its executable mode. This also handles source builds and keeps a plain `bun install` usable on macOS.

To verify compilation rather than using the vendor prebuild:

```sh
npm_config_build_from_source=true bun install --force
bun run check
```

Both this source-build path and plain `bun install --force` were exercised on macOS arm64. The source-build flag is documented by [node-pty's install script](https://github.com/microsoft/node-pty/blob/main/scripts/prebuild.js).

Desktop packaging will rebuild node-pty in the staged Electron app for that Electron version and architecture. Add `@electron/rebuild` as desktop build tooling when that package exists, then run, for example:

```sh
bunx @electron/rebuild --force --which-module node-pty \
  --build-from-source --version "$ACE_ELECTRON_VERSION" \
  --module-dir "$ACE_STAGED_APP_DIR"
```

Remove node-pty's bundled `prebuilds` directory in the staged copy before rebuilding, so it loads the rebuilt `build/Release` artifact. Rebuild in the staged copy rather than overwriting the standalone daemon's native binary. Package the native addon and macOS spawn helper outside ASAR and preserve the helper's executable mode. The future desktop build must smoke-test PTY spawning under Electron itself. See [Electron rebuild's CLI documentation](https://github.com/electron/rebuild#cli-arguments). No Electron dependency or wiring is added here.

## Verification

```sh
bun run check
node packages/terminal/scripts/mutations.ts
bun run --filter @ace/terminal bench 100
```

Tests use real PTYs, isolated startup files and shell/output barriers. There are no elapsed-time assertions or sleeps for synchronization. The 20 MiB case checks retained bytes, heap and buffer allocations, resync and successful shell completion. Test-runner timeouts only prevent hangs.

The mutation audit sequentially edits production code, runs each guarding real-PTY test, and restores the original file in `finally`. Do not run it concurrently with edits or tests in the same worktree. Eleven mutations were killed, including retaining all output strings outside the ring.

The benchmark is optional and non-gating. It reports throughput, retained bytes, allocation changes and the stalled reader's outcome. On one macOS arm64 run with Node 26.8.1, 100 MiB drained at about 152 MiB/s with 4 MiB retained and a `resync` event. This is a local observation, not a performance requirement.
