/*
 * The Linux screen as an ace-media producer (docs/media/plan.md, E2), every edge real: the
 * built Linux helper sharing GNOME Calculator through the RemoteDesktop/ScreenCast portal and
 * PipeWire, its encoder (the last-resort Chrome encoder on a machine without VA-API or NVIDIA,
 * else the one opted in), the built ace-media binary, its ingest socket and egress lane, and
 * the screen manager's legacy viewer. What only this can show: the helper's MediaFrames are
 * accepted by ace-media and come back on egress as the frames the helper socket would carry;
 * route flips between the daemon's JPEG path and ace-media lose and repeat no frame; and a
 * killed ace-media puts the screen back on the helper socket within 2 s.
 * Runs on Linux with ACE_SCREEN_INTEGRATION=1, ACE_MEDIA_TEST_BINARY naming a built ace-media
 * and ACE_LINUX_HELPER a built helper, inside a GNOME Wayland session (wayland-session.sh)
 * where the person's approval is recorded by seed_portal.py.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import { platformRouteCapabilities } from "@ace/media/routes";
import { MediaRuntime } from "@ace/media/runtime";
import { readProducerStamp } from "@ace/media/producer-stamp";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ScreenManager, type Frame } from "./index.ts";
import { linuxLaunch } from "./linux.ts";
import { screenOpeningEpoch } from "./media-source.ts";
import { ids } from "./testing/support.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const helper = process.env.ACE_LINUX_HELPER?.trim() || undefined;
const runs =
  process.platform === "linux" &&
  process.env.ACE_SCREEN_INTEGRATION === "1" &&
  !!binary &&
  !!helper;
const tests = new URL("../../../native/screen-helper-linux/tests/computer/", import.meta.url)
  .pathname;

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.runIf(runs)(
  "a Linux screen streams through ace-media and egress to its legacy viewer, survives route flips without losing or repeating a frame, and falls back to the helper socket within 2 s of ace-media being killed",
  { timeout: 240_000 },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ace-e2-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const artifacts = join(dataDir, "screen-artifacts");
    const token = join(artifacts, "portal", "restore-token");
    const calculator = spawnSupervised({
      command: "gnome-calculator",
      name: "e2-calculator",
      args: [],
      env: {},
    });
    onTestFinished(async () => {
      await calculator.stop({ graceMs: 0 });
    });
    await pause(4_000);
    // The person approves sharing Calculator (recorded as the dialog would record it).
    execFileSync("python3", [
      join(tests, "seed_portal.py"),
      "grant-remote-desktop",
      token,
      "org.gnome.Calculator.desktop",
      "Calculator",
    ]);
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const producers = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir: dataDir,
      dataDir,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      capabilities: platformRouteCapabilities("linux"),
    });
    onTestFinished(() => producers.dispose());
    const viaEgress = new Set<number>();
    const ended: { at: number; interrupted: boolean }[] = [];
    const epochs = new Set<number>();
    const counted = (unit: EgressUnit) => {
      const stamp = readProducerStamp(unit.frame.extension);
      if (stamp) viaEgress.add(stamp.sequence);
      epochs.add(unit.frame.epoch);
    };
    const manager = new ScreenManager({
      command: helper ?? "",
      protocolVersion: 2,
      launch: async () => linuxLaunch(process.env, artifacts),
      nextId: ids(),
      recordingDirectory: artifacts,
      publishArtifact: async () => {},
      media: {
        add: (producer) =>
          producers.sources.add({
            ...producer,
            pathEnded: (path, interrupted) => {
              ended.push({ at: performance.now(), interrupted });
              producer.pathEnded?.(path, interrupted);
            },
            consumers: {
              deliver: (unit) => {
                counted(unit);
                producer.consumers.deliver(unit);
              },
            },
          }),
      },
    });
    onTestFinished(() => manager.close());
    await manager.enable(true);
    const state = await manager.start({ kind: "chooser" });
    const id = state.sessionId;
    const frames: { frame: Frame; at: number }[] = [];
    const stop = manager.subscribeEvery(id, (frame) =>
      frames.push({ frame, at: performance.now() }),
    );
    onTestFinished(stop);
    await manager.configureStream(id, {
      codec: "h264",
      maxWidth: 1280,
      maxHeight: 1280,
      fps: 30,
      bitrate: 2_000_000,
    });
    const h264 = () => frames.filter((entry) => entry.frame.header.codec === "h264");
    const stills = (after: number) =>
      frames.filter((entry) => entry.at > after && entry.frame.header.codec === "jpeg");
    // Calculator changes only when touched: keyframes asked for keep units coming, at most two a
    // second (the helper forces one every 500 ms at most), so each wait asks for a few.
    const keyframes = setInterval(() => void manager.requestKeyframe(id).catch(() => {}), 100);
    onTestFinished(() => clearInterval(keyframes));

    // Through ace-media: every H.264 frame came on egress, with today's header. The first
    // waits for ace-media to start and the last-resort encoder's Chrome with it.
    await until(() => h264().length >= 4, 60_000);
    expect(producers.supervisor.health()).toBe("healthy");
    expect(h264().every((entry) => viaEgress.has(entry.frame.header.sequence))).toBe(true);
    const keyframe = h264().find((entry) => entry.frame.header.keyframe)?.frame;
    expect(keyframe?.header).toMatchObject({
      version: 1,
      sessionId: id,
      codec: "h264",
      keyframe: true,
      videoCodec: expect.stringMatching(/^avc1\.[0-9A-F]{6}$/),
    });
    expect(keyframe?.payload.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    // Stamped at capture with the source's epoch (0 only for a picture from before it).
    expect(epochs.has(screenOpeningEpoch)).toBe(true);
    expect([...epochs].every((epoch) => epoch === 0 || epoch === screenOpeningEpoch)).toBe(true);

    // Route flips: legacy (JPEG pictures on the helper socket: Calculator holds still, so the
    // picture on screen once), auto (H.264 through ace-media).
    for (const encode of ["legacy", "auto", "legacy", "auto"] as const) {
      const flipped = performance.now();
      settings.encode = encode;
      producers.settingsChanged();
      await until(() =>
        encode === "auto"
          ? h264().filter((entry) => entry.at > flipped).length >= 4
          : stills(flipped).length >= 1,
      );
    }
    await pause(500);
    // Each codec in its own order, none twice; within each ace-media run, no hole.
    for (const codec of ["h264", "jpeg"] as const) {
      const sequences = frames
        .filter((entry) => entry.frame.header.codec === codec)
        .map((entry) => entry.frame.header.sequence);
      expect(sequences.every((value, i) => i === 0 || value > (sequences[i - 1] ?? -1))).toBe(true);
    }
    expect(manager.state(id).lifecycle).toBe("live");
    // Each planned move off ace-media wrote its queue and an end frame: a clean end.
    expect(ended.length).toBeGreaterThanOrEqual(2);
    expect(ended.every((end) => !end.interrupted)).toBe(true);

    // ace-media killed: the helper socket carries the screen again within 2 s (the helper's
    // own fallback sends its video there at once; the daemon then asks for pictures).
    const direct = (after: number) =>
      frames.filter(
        (entry) =>
          entry.at > after &&
          !(entry.frame.header.codec === "h264" && viaEgress.has(entry.frame.header.sequence)),
      );
    const pid = producers.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => direct(killed).length > 0, 5_000);
    expect((direct(killed)[0]?.at ?? Infinity) - killed).toBeLessThan(2_000);
    const before = h264().length;
    await until(() => h264().length > before + 4, 30_000);
    expect(producers.supervisor.snapshot().pid).not.toBe(pid);
    expect(ended.filter((end) => end.at > killed).some((end) => end.interrupted)).toBe(true);
  },
);
