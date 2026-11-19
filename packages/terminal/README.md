# @ace/terminal

PTY sessions owned by the local daemon. This package has no client UI or daemon transport wiring. The daemon runs on Bun, and its terminals use Bun's own PTY (`Bun.spawn({ terminal })`, ConPTY on Windows); schemas come from the existing `@ace/protocol` workspace package.

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
const watching = (async () => {
  for await (const event of attachment) {
    if (event.type === "data") {
      // Send event.data to the terminal renderer. Save event.endOffset as the cursor.
    } else if (event.type === "resync") {
      // Clear the renderer and attach again from event.oldestOffset.
    } else {
      // event.status is { code, signal }. All retained output preceded this event.
    }
  }
})();

terminal.write("echo hello\r");
terminal.resize(120, 40);
await terminal.kill("SIGTERM");
await manager.closeAll(); // Escalates if the interactive shell ignores SIGTERM.
const status = await terminal.exited;
await watching;
const snapshot = terminal.snapshot();
```

Start one consumer task per attachment. Call `attachment.detach()` to cancel a pending read, or break from its `for await` loop. Neither operation affects the PTY or another watcher. Permit only one outstanding `next()` per attachment.

`name` is a display label. The terminal type is always `xterm-256color`; `COLORTERM` is always `truecolor`, even if `env` overrides them. Other environment values override the daemon's environment; `undefined` removes an inherited value. Environment values are not included in snapshots.

The shell is the explicit `shell`, otherwise the daemon's `$SHELL`, otherwise the first executable of `/bin/zsh` and `/bin/bash`. It runs with `-l -i` and reads the user's normal startup files. An explicitly configured shell that cannot launch fails rather than silently selecting another shell. Dimensions must be integers from 1 through 65535, matching native winsize fields. Rejected resizes preserve the current size. The public `PtyBackend` interface owns native output, input, resizing and process-group termination; a future ConPTY backend can implement it without changing scrollback or attachments.

## Offsets and bounded memory

Offsets count raw output bytes starting at zero, including terminal escape sequences and CRLF. Data events carry `offset`, exclusive `endOffset`, UTF-8 `data`, and `truncatedBefore`. Always persist `endOffset` rather than deriving it from JS string length.

Each terminal allocates one byte ring, default 4 MiB, configurable on the manager with a minimum of four bytes. Every PTY read goes straight into it. Attachments keep a cursor and at most one pending read; there is no per-reader output queue. Delivery chunks contain at most 64 KiB of source bytes. Callers own the events they consume and must bound their own socket queues.

`attach()` starts at the current oldest retained byte. An explicit offset behind the ring starts at its oldest complete character and sets `truncatedBefore` on the first data event only. An offset inside a character advances to the next character and also sets that flag. Negative, fractional or future offsets throw.

If a cursor is overwritten after attachment, its next read receives `resync` with the current `oldestOffset` and `nextOffset`, then the iterator ends. Re-attach from `oldestOffset` to replay the retained tail. Resync delivery is pull-based; a watcher that stops reading keeps no output queue. The PTY continues draining when some, all, or no watchers read.

Incomplete UTF-8 suffixes stay in the raw ring until their remaining bytes arrive. Complete characters are never divided across delivery chunks. Invalid source bytes and an incomplete suffix at exit decode with replacement characters, while offsets still count the original bytes. A raw snapshot preserves those bytes exactly.

## Shutdown and persistence

`closeAll()` permanently closes admission and shares an in-flight shutdown. Successful shutdown is idempotent; failed shutdown can be retried after repairing its I/O boundary. Writes and resize stay disabled once shutdown begins. Ownership follows the POSIX session created by the PTY, so ordinary jobs remain owned after redirection, disowning, shell exit and reparenting. A small FIFO-controlled native keeper reserves the original process-group ID even after the user shell exits, preventing that ID from being reused while owned. The user shell replaces its launcher with exec, preserving the PTY PID. Every individual group signal revalidates current membership and requires the reserved group; a recycled session without it is rejected. Secondary groups also require a kernel ownership proof: a keeper child calls `setpgid` to join the target group within its own session. The kernel rejects foreign-session groups even if inventory was stale. A guardian remains in each joined group until cleanup, reserving its ID through STOP and inventory failures. The keeper ignores catchable signals. FIFO EOF triggers cleanup of the entire owned session, with the original shell group killed last. Before reading membership, a write to the private FIFO proves that its original reader still exists; losing that lease fails shutdown rather than trusting recycled numeric IDs. Zombies are already stopped.

Shutdown sends SIGTERM to every current owned group, waits the configured grace, then discovers jobs again. It freezes the original shell PID and sends SIGSTOP to other job groups to limit concurrent fork churn. The FIFO keeper stays runnable, including if the daemon dies while its shell or other jobs are frozen. On FIFO EOF it kills pinned jobs, discovers remaining same-session groups and pins/kills them too, then kills the original group. Shutdown kills job groups first and releases the reserved group last. After releasing it, shutdown only verifies termination and never signals through that ownership again. Escalation completes the current stop/kill sweep before checking its one-second injected deadline, with at most 32 sweeps. Individual system queries have five-second failure timeouts, so the deadline limits repeated sweeps rather than promising a one-second total latency. On failure, shutdown resumes surviving paused job groups through their kernel pins without depending on process inventory. Every resume is attempted, and failed recovery targets remain available for retry. STOP targets are recorded before acknowledgment so a delayed or missing reply does not strand a paused job. A private-lease check can resume the original group even if inventory is unavailable; ownership remains retained for retry. Errors are aggregated after attempting every terminal. `kill(signal)` targets current owned session groups too. Explicit SIGSTOP freezes the original shell separately so the lifetime keeper stays runnable; secondary groups are paused through their pins.

Linux obtains session IDs from `ps`. macOS masks the `ps` session fields, so its built-in `/usr/bin/osascript` JavaScript bridge batches libc `getsid` calls. Concurrent terminals in one manager share in-flight process inventories. No process environments are inspected, no provider CLI is invoked, and no extra addon or package is installed. This macOS bridge can be replaced at the exported backend seam later.

This is supervision, not isolation: a program that deliberately creates another POSIX session escapes this session ownership model. Ordinary `disown` does not. Terminal handles reject writes and resize after exit or during shutdown.

The manager accepts `dependencies` with `backendFactory`, `resolveShell`, `createSessionId`, and `shutdownScheduler` (`now`, `delay`). `createPosixBackendFactory` also accepts native-spawn, process-control and lease-creation ports, plus a filesystem root for lease files. POSIX installation uses the system `/bin/sh` and `/usr/bin/mkfifo` as well as `ps`. Defaults live in the I/O shell; pure ownership decisions and schema-backed decoders do not access global clocks, process spawners or randomness. Malformed native exit events reject `exited` and pending watchers rather than publishing an invalid status. That decoding failure does not prevent successful process cleanup and explicit history release.

`snapshot()` returns JSON-safe versioned metadata, dimensions, capacity, raw byte offsets, base64 retained bytes and the retained exit status. A snapshot may start inside a UTF-8 character or end with an incomplete one. Restore consumers must align/decode it as described above. Snapshot loading and restarting live shells are left to future daemon work. After persisting a snapshot, call `await manager.release(terminal)` to stop any remaining owned jobs, free its ring and remove the manager's handle. Late attachment remains available until explicit release. Released handles reject replay and snapshots. The daemon chooses when to release historical terminals.

## Native installation

The daemon needs no PTY package: Bun provides the terminal. The root postinstall compiles the package-owned POSIX keeper (`native/group-keeper`) with `cc`; the release and desktop builds compile it for their target. It is a standalone libc executable.

node-pty is a development dependency only. Tests that run on Node (where Bun's terminal does not exist) open terminals through it, loaded on first use; the daemon never loads it. Root `trustedDependencies` allows node-pty's install hooks, which use its prebuilds or `node-gyp` (C/C++ toolchain and Python; see the [node-pty build instructions](https://github.com/microsoft/node-pty#dependencies)). node-pty 1.1.0's macOS tarball has a non-executable prebuilt spawn helper; the root postinstall runs this package's `prepare-native` script to set its executable mode.
