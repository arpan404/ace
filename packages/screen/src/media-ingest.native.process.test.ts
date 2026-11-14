/*
 * The Mac screen as an ace-media producer (docs/media/plan.md, E3), every edge real: the built
 * screen helper capturing an animated fixture window, the built ace-media binary, its ingest
 * socket and egress lane, and the screen manager's legacy viewer. What only this can show:
 * the helper's MediaFrames are accepted by ace-media and come back on egress as the frames the
 * helper socket would have carried; route changes between the two paths lose and repeat no
 * frame; and a killed ace-media puts the screen back on the helper socket within 2 s.
 * Runs on macOS with ACE_SCREEN_INTEGRATION=1 and ACE_MEDIA_TEST_BINARY naming a built
 * ace-media, and needs the helper's existing Screen Recording grant.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import { MediaProducers } from "@ace/media/producers";
import { readProducerStamp } from "@ace/media/producer-stamp";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory } from "@ace/protocol";
import { ScreenManager, type Frame } from "./index.ts";
import { screenOpeningEpoch } from "./media-source.ts";
import { ids } from "./testing/support.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const runs =
  process.platform === "darwin" && process.env.ACE_SCREEN_INTEGRATION === "1" && !!binary;
const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.runIf(runs)(
  "a Mac screen streams through ace-media and egress to its legacy viewer, survives route flips without losing or repeating a frame, and falls back to the helper socket within 2 s of ace-media being killed",
  { timeout: 120_000 },
  async (context) => {
    for (const script of ["build.sh", "build-test-window.sh"])
      expect(
        (await probeOutput("sh", [join(directory, script)], { timeoutMs: 300_000 })).code,
      ).toBe(0);
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-e3-"));
    onTestFinished(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    };
    const producers = new MediaProducers({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir,
      dataDir: runtimeDir,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      platform: "darwin",
    });
    onTestFinished(() => producers.dispose());
    // Which frames came back on egress, by the helper's own sequence.
    const viaEgress = new Set<number>();
    const epochs = new Set<number>();
    const counted = (unit: EgressUnit) => {
      const stamp = readProducerStamp(unit.frame.extension);
      if (stamp) viaEgress.add(stamp.sequence);
      epochs.add(unit.frame.epoch);
    };
    const manager = new ScreenManager({
      command: join(directory, "build/ace-screen-helper"),
      // The helper's own Screen Recording grant, tied to its unchanged signing identity.
      nextId: ids(),
      recordingDirectory: runtimeDir,
      publishArtifact: async () => {},
      media: {
        add: (producer) =>
          producers.sources.add({
            ...producer,
            consumers: {
              deliver: (unit) => {
                counted(unit);
                producer.consumers.deliver(unit);
              },
              record: producer.consumers.record,
              still: producer.consumers.still,
            },
          }),
      },
    });
    onTestFinished(() => manager.close());
    await manager.enable(true);
    const permissions = await manager.permissions();
    if (!permissions.screenRecording) {
      context.skip("Requires the helper's existing Screen Recording grant");
      return;
    }
    const app = spawnSupervised({
      command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
      name: "screen-e3-window",
      // A measurement fixture comes forward without taking focus from the person at the Mac.
      args: [
        "ace e3 ingest",
        "--animate",
        "--smoothness-latency",
        "-ApplePersistenceIgnoreState",
        "YES",
      ],
      env: {},
    });
    onTestFinished(async () => {
      await app.stop({ graceMs: 0 });
    });
    await once(app.stdout, "line");
    // The display, showing only the fixture app: no Accessibility window to resolve.
    const inventory = ScreenInventory.parse(await manager.targets());
    const window = inventory.windows.find(
      (entry) => entry.bundleId === "dev.ace.screen-test" && entry.title === "ace e3 ingest",
    );
    const display = inventory.displays[0];
    if (!window || !display) throw new Error("The fixture window is not a capture target");
    const state = await manager.start({
      kind: "display",
      displayId: display.displayId,
      bundleIds: ["dev.ace.screen-test"],
    });
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
    const egressed = () => h264().filter((entry) => viaEgress.has(entry.frame.header.sequence));
    const direct = (after: number) =>
      h264().filter((entry) => entry.at > after && !viaEgress.has(entry.frame.header.sequence));

    // Through ace-media: the frames carry today's header, field for field.
    await until(() => egressed().length >= 20);
    expect(producers.supervisor.health()).toBe("healthy");
    const keyframe = egressed().find((entry) => entry.frame.header.keyframe)?.frame;
    expect(keyframe?.header).toMatchObject({
      version: 1,
      sessionId: id,
      codec: "h264",
      keyframe: true,
      videoCodec: expect.stringMatching(/^avc1\.[0-9A-F]{6}$/),
    });
    expect(keyframe?.header.scale).toBeGreaterThan(0);
    expect(keyframe?.payload.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(keyframe?.header.bytes).toBe(keyframe?.payload.length);
    // The helper stamps each picture with the epoch it held at capture: the source's, or 0 for
    // one captured before it was given any (a keyframe can re-encode such a picture).
    expect(epochs.has(screenOpeningEpoch)).toBe(true);
    expect([...epochs].every((epoch) => epoch === 0 || epoch === screenOpeningEpoch)).toBe(true);

    // Route flips: legacy, auto, legacy, auto. Every frame is handed on once, in order, and the
    // helper's sequence has no hole at any flip.
    for (const encode of ["legacy", "auto", "legacy", "auto"] as const) {
      const flipped = performance.now();
      settings.encode = encode;
      producers.settingsChanged();
      const onPath = () =>
        h264().filter(
          (entry) =>
            entry.at > flipped &&
            viaEgress.has(entry.frame.header.sequence) === (encode === "auto"),
        );
      await until(() => onPath().length >= 10);
    }
    await pause(500);
    const sequences = h264().map((entry) => entry.frame.header.sequence);
    expect(
      sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)),
    ).toBe(true);
    const holes = sequences.filter(
      (value, index) => index > 0 && value !== (sequences[index - 1] ?? 0) + 1,
    );
    expect(holes).toEqual([]);
    expect(manager.state(id).lifecycle).toBe("live");

    // ace-media killed: the screen is back on the helper socket within 2 s, then on the new
    // ace-media once it is up again.
    await until(() => egressed().length > 40);
    const pid = producers.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => direct(killed).length > 0, 5_000);
    const fallback = (direct(killed)[0]?.at ?? Infinity) - killed;
    expect(fallback).toBeLessThan(2_000);
    const restarted = egressed().length;
    await until(() => egressed().length > restarted + 10, 20_000);
    expect(producers.supervisor.snapshot().pid).not.toBe(pid);
    expect(manager.state(id).lifecycle).toBe("live");
  },
);
