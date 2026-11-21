/*
 * The Mac screen as an ace-media producer (docs/media/plan.md, E3), every edge real: the built
 * screen helper capturing an animated fixture window, the built ace-media binary, its ingest
 * socket and egress lane, and the screen manager's legacy viewer. What only this can show:
 * the helper's MediaFrames are accepted by ace-media and come back on egress as the frames the
 * helper socket would have carried; route changes between the two paths lose and repeat no
 * frame; and a killed ace-media puts the screen back on the helper socket within 2 s.
 * Runs on macOS with ACE_SCREEN_INTEGRATION=1 and ACE_MEDIA_TEST_BINARY naming a built
 * ace-media, and needs the helper's existing Screen Recording grant.
 *
 * Windows (E1) runs the same checks against the built Windows helper (ACE_WINDOWS_SCREEN_HELPER)
 * capturing the Rust fixture window, its Media Foundation H.264 on ace-media's ingest named
 * pipe, and also decodes what the legacy viewer got in a real Chromium's WebCodecs; with no
 * MFT the helper offers JPEG only, so the daemon's last-resort encoder makes the video. Run by
 * scripts/vitest-windows-screen.config.ts with ACE_MEDIA_TEST_BINARY set.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import { platformRouteCapabilities } from "@ace/media/routes";
import { MediaRuntime } from "@ace/media/runtime";
import { readProducerStamp } from "@ace/media/producer-stamp";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory, type ScreenStreamSettings } from "@ace/protocol";
import { z } from "zod";
import { ScreenManager, type Frame } from "./index.ts";
import { screenOpeningEpoch } from "./media-source.ts";
import { ids } from "./testing/support.ts";
import { decodeInChromium } from "./testing/webcodecs.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const runs =
  process.platform === "darwin" && process.env.ACE_SCREEN_INTEGRATION === "1" && !!binary;
const windowsHelper = process.env.ACE_WINDOWS_SCREEN_HELPER?.trim() || undefined;
const windowsRuns = process.platform === "win32" && !!binary && !!windowsHelper;
const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;

async function until(
  condition: () => boolean,
  ms = 15_000,
  explain: () => string = () => "",
): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`timed out ${explain()}`);
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
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const producers = mediaRuntime(runtimeDir, settings, "darwin");
    onTestFinished(() => producers.dispose());
    const watched = observe(producers);
    const manager = new ScreenManager({
      command: join(directory, "build/ace-screen-helper"),
      // The helper's own Screen Recording grant, tied to its unchanged signing identity.
      nextId: ids(),
      recordingDirectory: runtimeDir,
      publishArtifact: async () => {},
      media: watched.media,
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
    await throughAceMedia({ frames, watched, producers, settings, manager, id });
  },
);

/** The daemon's ace-media runtime on this platform's route capabilities. */
function mediaRuntime(runtimeDir: string, settings: MediaSettings, platform: string) {
  return new MediaRuntime({
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
    randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
    id: randomUUID,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    log: () => {},
    capabilities: platformRouteCapabilities(platform),
  });
}

/** The screen manager's ace-media sources, watched: what came back on egress, and path ends. */
function observe(producers: MediaRuntime) {
  // Which frames came back on egress, by the helper's own sequence.
  const viaEgress = new Set<number>();
  /** How each ace-media path ended: clean (its end frame came) or interrupted. */
  const ended: { at: number; interrupted: boolean }[] = [];
  const epochs = new Set<number>();
  const counted = (unit: EgressUnit) => {
    const stamp = readProducerStamp(unit.frame.extension);
    if (stamp) viaEgress.add(stamp.sequence);
    epochs.add(unit.frame.epoch);
  };
  const media: ConstructorParameters<typeof ScreenManager>[0]["media"] = {
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
  };
  return { viaEgress, ended, epochs, media };
}

/**
 * A live screen through ace-media: today's frame header back from egress, epochs stamped at
 * capture, four route flips with no hole or repeat and clean ends, and a killed ace-media put
 * back on the helper socket within 2 s, then onto the restarted process.
 */
async function throughAceMedia(run: {
  frames: { frame: Frame; at: number }[];
  watched: ReturnType<typeof observe>;
  producers: MediaRuntime;
  settings: MediaSettings;
  manager: ScreenManager;
  id: string;
}) {
  const { frames, producers, settings, manager, id } = run;
  const { viaEgress, ended, epochs } = run.watched;
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
          entry.at > flipped && viaEgress.has(entry.frame.header.sequence) === (encode === "auto"),
      );
    await until(
      () => onPath().length >= 10,
      15_000,
      () =>
        JSON.stringify({
          encode,
          after: frames.filter((entry) => entry.at > flipped).length,
          h264After: h264().filter((entry) => entry.at > flipped).length,
          egressAfter: h264().filter(
            (entry) => entry.at > flipped && viaEgress.has(entry.frame.header.sequence),
          ).length,
          ended,
          health: producers.supervisor.health(),
          lifecycle: manager.state(id).lifecycle,
        }),
    );
    // How long the handover took: a clean one is a frame interval, a held one 1 s or more.
    console.log(
      `flip to ${encode}: first frame on the new path after ${Math.round((onPath()[0]?.at ?? 0) - flipped)} ms`,
    );
  }
  await pause(500);
  // From the last helper-socket frame before the first switch on: before it the socket's own
  // writer may coalesce a frame under load, which is today's path, not a handoff.
  const all = h264();
  const firstSwitch = Math.max(
    0,
    all.findIndex((entry) => viaEgress.has(entry.frame.header.sequence)) - 1,
  );
  const sequences = all.slice(firstSwitch).map((entry) => entry.frame.header.sequence);
  expect(
    sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)),
  ).toBe(true);
  const holes = sequences.filter(
    (value, index) => index > 0 && value !== (sequences[index - 1] ?? 0) + 1,
  );
  expect(holes).toEqual([]);
  expect(manager.state(id).lifecycle).toBe("live");
  // Each planned move off ace-media wrote its queue and an end frame: a clean end, no cut.
  expect(ended.length).toBeGreaterThanOrEqual(2);
  expect(ended.every((end) => !end.interrupted)).toBe(true);

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
  // The killed process's path ended in failure: interrupted.
  expect(ended.filter((end) => end.at > killed).some((end) => end.interrupted)).toBe(true);
}

/** The Rust fixture window, its handle, and a way to keep it repainting. */
async function windowsFixture(title: string) {
  const helper = windowsHelper ?? "";
  const child = spawnSupervised({
    command: join(dirname(helper), "examples", "computer_fixture.exe"),
    name: "screen-e1-window",
    args: ["--title", title],
    env: {},
  });
  onTestFinished(async () => {
    await child.stop({ graceMs: 0 });
  });
  const [line] = (await once(child.stdout, "line")) as [string];
  const hwnd = z.object({ hwnd: z.number() }).parse(JSON.parse(line)).hwnd;
  // Twenty colours 40 ms apart, again and again: a steady stream of changed pictures.
  const colours = Array.from({ length: 20 }, (_, i) =>
    (i * 0x0c1f37).toString(16).padStart(6, "0").slice(-6),
  );
  const timer = setInterval(() => child.stdin.write(`burst ${colours.join(",")}\n`), 800);
  onTestFinished(() => clearInterval(timer));
  return hwnd;
}

/** A Windows session on the fixture window, with every frame its viewer got. */
async function windowsSession(manager: ScreenManager, hwnd: number) {
  await manager.enable(true);
  const inventory = ScreenInventory.parse(await manager.targets());
  const owned = inventory.windows.find((entry) => entry.windowId === hwnd);
  if (!owned) throw new Error("The fixture window is not a capture target");
  const state = await manager.start({ kind: "window", bundleId: owned.bundleId, windowId: hwnd });
  const frames: { frame: Frame; at: number }[] = [];
  const stop = manager.subscribeEvery(state.sessionId, (frame) =>
    frames.push({ frame, at: performance.now() }),
  );
  onTestFinished(stop);
  return { id: state.sessionId, frames };
}

const video: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1280,
  maxHeight: 1280,
  fps: 30,
  bitrate: 2_000_000,
};

/** A Chromium on this machine: Edge ships with Windows. */
const chromium = () =>
  process.env.ACE_TEST_CHROMIUM?.trim() ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

it.runIf(windowsRuns)(
  "a Windows screen's Media Foundation video streams through ace-media and egress to its legacy viewer, decodes in WebCodecs, survives route flips without losing or repeating a frame, and falls back to the helper pipe within 2 s of ace-media being killed",
  { timeout: 180_000 },
  async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-e1-"));
    onTestFinished(() => rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10 }));
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const producers = mediaRuntime(runtimeDir, settings, "win32");
    onTestFinished(() => producers.dispose());
    const watched = observe(producers);
    const manager = new ScreenManager({
      command: windowsHelper ?? "",
      nextId: ids(),
      recordingDirectory: runtimeDir,
      publishArtifact: async () => {},
      media: watched.media,
    });
    onTestFinished(() => manager.close());
    const hwnd = await windowsFixture(`ace-e1-${process.pid}`);
    const { id, frames } = await windowsSession(manager, hwnd);
    // The hello's capture → encode report, from the helper's start-up trial.
    const capabilities = await manager.capabilities(id);
    expect(capabilities?.codecs).toContain("h264");
    expect(capabilities?.encoders).toContainEqual(
      expect.objectContaining({ step: "encode", backend: "mf", state: "ok" }),
    );
    expect((await manager.configureStream(id, video)).codec).toBe("h264");

    // What the legacy viewer got through egress decodes in WebCodecs, as the web client would.
    await until(
      () =>
        frames.filter((entry) => watched.viaEgress.has(entry.frame.header.sequence)).length >= 30,
      30_000,
    );
    const egressed = frames
      .map((entry) => entry.frame)
      .filter(
        (frame) => frame.header.codec === "h264" && watched.viaEgress.has(frame.header.sequence),
      );
    const first = egressed.findIndex((frame) => frame.header.keyframe);
    const run = egressed.slice(first, first + 30);
    const codec = run[0]?.header.videoCodec ?? "";
    expect(codec).toMatch(/^avc1\.[0-9A-F]{6}$/);
    const decoded = await decodeInChromium(
      chromium(),
      codec,
      run.map((frame) => ({ payload: frame.payload, keyframe: frame.header.keyframe === true })),
    );
    expect(decoded.errors).toEqual([]);
    expect(decoded.decoded).toBe(run.length);
    expect([decoded.width, decoded.height]).toEqual([run[0]?.header.width, run[0]?.header.height]);

    await throughAceMedia({ frames, watched, producers, settings, manager, id });
  },
);

it.runIf(windowsRuns)(
  "a Windows helper with no Media Foundation encoder offers JPEG only and says so, so live view uses the last-resort encoder",
  { timeout: 60_000 },
  async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-e1-nomft-"));
    onTestFinished(() => rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10 }));
    const manager = new ScreenManager({
      command: windowsHelper ?? "",
      nextId: ids(),
      recordingDirectory: runtimeDir,
      publishArtifact: async () => {},
      env: { ACE_SCREEN_HELPER_NO_MFT: "1" },
    });
    onTestFinished(() => manager.close());
    const hwnd = await windowsFixture(`ace-e1-nomft-${process.pid}`);
    const { id, frames } = await windowsSession(manager, hwnd);
    const capabilities = await manager.capabilities(id);
    expect(capabilities?.codecs).toEqual(["jpeg"]);
    expect(capabilities?.encoders).toContainEqual(
      expect.objectContaining({ step: "encode", backend: "mf", state: "failed", maxWidth: 0 }),
    );
    // The daemon is told JPEG, which sends live view through the last-resort encoder.
    expect((await manager.configureStream(id, video)).codec).toBe("jpeg");
    await until(() => frames.length >= 3, 15_000);
    expect(frames.every((entry) => entry.frame.header.codec === "jpeg")).toBe(true);
  },
);
