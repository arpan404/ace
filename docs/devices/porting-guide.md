# Porting devices work to Rust

For the builder who moves Android's live video into ace-media. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The engine's [porting guide](../engine/porting-guide.md) sets the rules
for daemon crates; ace-media's own rules are in [docs/media/plan.md](../media/plan.md) and
`native/media/README.md`. Where this guide is silent, follow those.

Branch from `ace/daemon-rust-rewrite`, one branch for the item (`ace/rust-devices-d1`).

## What is not ported

ADR 0225 keeps the device control plane in TypeScript: leases, cowork, refs, `sim_*` tools, the
bridge, the client, SDK commands, inventory, recordings' control, chrome and skins. Its cost is
28 to 636 µs per call beside SDK commands that take far longer, and its output (error text, tool
results, wire messages) is JavaScript-shaped. Don't port any of it, and don't start a Rust
devices process. The SDK and helper spawns gain from ADR 0223 E2 (`ACE_SUPERVISOR=native`)
without any change here: run the devices (a) process files with that switch on when E2 asks.

## Rules for D1

1. **Same TypeScript interface.** `DevicesService`, `startCapture`, the capture's `publish`,
   `DeviceVideoPaths` and everything a viewer sees stay as they are. The `VideoUnit`s the capture
   receives off egress are the same values, in the same order, numbered as before.
2. **One switch, one line.** `ACE_SCRCPY_VIDEO=media`, added to
   `packages/provider-kit/src/native-switches.ts` with its decision function. The shell asks it
   once per capture, at the point `scrcpy-capture.ts` builds its `DeviceVideoPaths`
   (`scrcpy-capture.ts:200`–`:212`). With the switch on and an ace-media that doesn't announce the
   scrcpy reader in its hello, the capture fails with today's typed error; never fall back.
3. **No new tests.** The (a) files below are the proof; you don't edit them. Run each alone,
   switch on and off, after checking the path exists (an empty path runs the whole suite):

   ```sh
   f=packages/devices/src/scrcpy-capture.process.test.ts
   test -f "$f" && ACE_SCRCPY_VIDEO=media bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, or `test:process`, `test:slow`,
   `test:changed`. Never run a live file (`scrcpy.live.process`, `device.live.process`): they
   drive a real phone or emulator, and the owner runs them.

4. **(b) cases move, they don't multiply.** The video half of `scrcpy-protocol.test.ts`
   (`VideoStreamReader`) and `scrcpy-video.test.ts` (`ScrcpyVideoUnits`) move into
   `#[cfg(test)]` beside the Rust reader, same inputs, same expectations. Their TypeScript stays
   until the forwarding path is deleted after default-on; the control half of `scrcpy-protocol`
   stays TypeScript for good.
5. **No parity harness.** No "run both and compare". New vectors in `native/media/vectors` only
   for framing nothing covers today, and the commit says which.
6. **ace-media's rules.** Its toolchain (`native/media/rust-toolchain.toml`, 1.95.0), its lints,
   `bun run check:media`; the pure half has no I/O (like `serve_sim.rs`, which is the model for
   this item), the shell's reader thread does the socket. Bounded everything: the packet limit is
   today's 8 MiB (`VideoStreamReader`, `scrcpy-protocol.ts:227`); a malformed packet ends the path
   with a reason, never the process.
7. **Lenient where the TypeScript is.** An unknown codec id or a cut-short stream is a stop with
   a reason the capture already maps (`device-video-status` tests), not a panic.
8. **Never drive real devices.** The (a) files use fake scrcpy servers and fake `adb`; keep it so.

## Files

| Part             | Files (yours)                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure reader      | `native/media/crates/ace-media/src/scrcpy.rs` (new): preamble, codec id, 12-byte headers, Annex B units, the same `MediaFrame` fields serve-sim's translator makes                                                                |
| Shell            | `native/media/crates/ace-media/src/shell/readers.rs`: a reader thread for the `scrcpy` origin, connecting `host:port`                                                                                                             |
| Sources          | `native/media/crates/ace-media/src/engine/sources.rs:246`: `reads_itself` also for `Origin::Scrcpy`, with its stamper                                                                                                             |
| Wire             | `media-wire/src/control.rs:130` already has `Scrcpy { host, port }`; add only a `connected` event if the hello cannot say it                                                                                                      |
| TypeScript shell | `packages/devices/src/scrcpy-capture.ts` (the switch line, the origin's real port), `scrcpy-server.ts` (connect control after ace-media reports the video socket connected), `packages/media/src/` wire types if the event is new |

## D1: ace-media reads scrcpy's video

Today the daemon connects both of scrcpy-server's tunnel sockets (`scrcpy-server.ts:70`,
`:112`), reads the video socket in JavaScript (`VideoStreamReader`, `scrcpy-protocol.ts:221`) and
writes each unit to ace-media's ingest (`IngestWriter`, `scrcpy-capture.ts:185`–`:240`); egress
brings each unit back (`media-paths.ts:158`–`:165`). After D1, with the switch on:

1. The daemon starts scrcpy-server and its `adb forward` exactly as today.
2. It opens the ace-media source with origin `scrcpy {host: "127.0.0.1", port}` instead of
   port 0, and does not connect the video socket itself.
3. ace-media connects first (the server greets its first socket, the video one,
   `scrcpy-server.ts:85`), reads the preamble and the stream, and reports that it is connected.
4. The daemon then connects the control socket, as the second connection, and keeps it: input,
   clipboard and keyframe requests stay in TypeScript.
5. Stop and restart (new viewer settings, a server restart, `scrcpyRestartWorthIt`) keep today's
   semantics: one source for the capture's life; ace-media ends a path with its end marker;
   video resumes at a keyframe.

Contract: behaviour.md §1 and §3 "Live views and pictures"; ADR 0147 and 0208 for the media
side. Proof, switch on and off:

- (a): `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `capture.process`,
  `platform.process`, `android-physical.process`, `emulator-window.process`.
- Also run with the switch on: `scrcpy-media-cleanup.process`, `scrcpy-host-capture.process`,
  `frame-encoder-media.process` (b files that exercise the path end to end).
- `cargo test` in `native/media` for the moved cases; `bun run check:media`.
- Measure: `packages/devices/bench/frames.ts` before and after (the JS framing it times leaves the
  path), and ask the owner to run `packages/devices/bench/emulator-video.ts` on a real emulator,
  switch off and on, under load, for fps and stalls: that is the gain ADR 0225 claims, and only a
  real device shows it.

## When you are done

- Every (a) file above passes alone with the switch on and off on macOS and Linux; the moved
  cases pass in `cargo test`; `check:media` passes.
- Report: the files run and their results, `frames.ts` before and after, anything in
  behaviour.md that turned out wrong (with the code that shows it), and the one test you added, if
  any, with the behaviour it covers that nothing did.
- Commit and push as you go with `git push origin HEAD:refs/heads/<your-branch>`; never rebase or
  force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
