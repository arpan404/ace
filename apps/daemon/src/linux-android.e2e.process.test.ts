/*
 * Android on Linux end to end: a person's device view and an agent's device tools on a real
 * Android device, through the real daemon. On Linux the picture is scrcpy's device-side H.264
 * (no host encoding); ffmpeg decodes what the viewer received. No provider CLI or model.
 * Opt-in only: `ACE_ANDROID_E2E_SDK` names an Android SDK folder whose `platform-tools/adb`
 * reaches the device. `apps/daemon/scripts/linux-e2e/android.sh` sets it, against a real
 * emulator or, on arm64 Linux where Google ships none, a stand-in.
 *
 * - `ACE_ANDROID_E2E_SERIAL`: the adb serial of the booted device (default `emulator-5554`); a
 *   network device's is its `host:port`.
 * - `ACE_ANDROID_E2E_BOOT_AVD`: instead, an AVD that is shut down. ace boots it headless and the
 *   whole flow runs on it; with `ACE_E2E_ARTIFACTS` set, boot time, first-picture latency, frame
 *   rate and the emulator's CPU are written to `android-metrics.json` there.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceInventory, DeviceScreenshot, DeviceState } from "@ace/protocol/devices";
import { ScreenUITreeResult } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { at, changed, decodeH264 } from "./testing/decode-h264.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";

const sdk = process.env.ACE_ANDROID_E2E_SDK;
const bootAvd = process.env.ACE_ANDROID_E2E_BOOT_AVD;
const serial = process.env.ACE_ANDROID_E2E_SERIAL ?? "emulator-5554";
const artifacts = process.env.ACE_E2E_ARTIFACTS;
const enabled = process.platform === "linux" && !!sdk;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

function decode(frames: readonly ViewerFrame[]) {
  return decodeH264(
    frames.map((frame) => frame.bytes),
    artifacts ? { directory: artifacts, name: "android" } : undefined,
  );
}

async function world(): Promise<EvalWorld> {
  // The daemon reads the SDK location from its environment, as it does for a person.
  if (sdk) process.env.ANDROID_HOME = sdk;
  const created = await evalWorld({ browser: false });
  cleanups.push(() => created.close());
  return created;
}

async function devicesViewer(ace: EvalWorld): Promise<LiveViewer> {
  const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath, "devices");
  cleanups.push(() => viewer.close());
  await viewer.request({ op: "enable", enabled: true });
  return viewer;
}

/** The centre of the first element whose text or name contains `text`, in device points. */
async function centreOf(viewer: LiveViewer, deviceId: string, text: string) {
  const found = ScreenUITreeResult.parse(
    await viewer.request({ op: "ui.find", deviceId, query: { text }, limit: 4 }),
  );
  const node = found.nodes[0];
  if (!node) throw new Error(`Nothing showing "${text}" on the device`);
  return {
    x: Math.round(node.bounds.x + node.bounds.w / 2),
    y: Math.round(node.bounds.y + node.bounds.h / 2),
  };
}

/** The first element on screen whose class is `role` (Android roles are class names). */
async function firstOfRole(viewer: LiveViewer, deviceId: string, role: string) {
  const found = ScreenUITreeResult.parse(
    await viewer.request({ op: "ui.find", deviceId, query: { role }, limit: 1 }),
  );
  return found.nodes[0];
}

/** Waits for `text` on screen; when it never shows, fails with what the screen held instead. */
async function waitToShow(viewer: LiveViewer, deviceId: string, text: string) {
  try {
    await expect.poll(() => shows(viewer, deviceId, text), { timeout: 45_000 }).toBe(true);
  } catch {
    const tree = JSON.stringify(await viewer.request({ op: "ui.tree", deviceId }));
    throw new Error(`"${text}" never showed; the screen held: ${tree.slice(0, 6000)}`);
  }
}

/** Whether any element on screen shows `text`. */
async function shows(viewer: LiveViewer, deviceId: string, text: string): Promise<boolean> {
  const found = ScreenUITreeResult.parse(
    await viewer.request({ op: "ui.find", deviceId, query: { text }, limit: 1 }),
  );
  return found.nodes.length > 0;
}

/** Seconds of CPU the emulator's processes have used so far (Linux `/proc`), when found. */
function emulatorCpuSeconds(): number | undefined {
  let pids: string[];
  try {
    pids = execFileSync("pgrep", ["-f", "qemu-system"], { encoding: "utf8" }).split(/\s+/);
  } catch {
    return undefined;
  }
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  let total = 0;
  for (const pid of pids.filter(Boolean)) {
    try {
      // Fields after the command's closing parenthesis; utime and stime are the 12th and 13th.
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
      total += (Number(fields[11]) + Number(fields[12])) / ticks;
    } catch {
      // The process ended between listing and reading.
    }
  }
  return total;
}

type Metrics = Record<string, number | string | undefined>;

/** The GLES renderer SurfaceFlinger reports on `transport`: which GPU mode the guest really got. */
function renderer(transport: string): string | undefined {
  try {
    const dump = execFileSync(
      join(sdk ?? "", "platform-tools", "adb"),
      ["-s", transport, "shell", "dumpsys SurfaceFlinger | grep -m1 GLES:"],
      { encoding: "utf8", timeout: 15_000 },
    );
    return dump.trim().slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a person does with a booted device: watch its H.264, open settings with a tap, type into
 * search, scroll, and take a screenshot. Records first-picture latency, frame rate and CPU.
 */
async function personDrives(viewer: LiveViewer, deviceId: string, metrics: Metrics) {
  // The device tools (the scrcpy server) download once, then the live view starts.
  await viewer.request({ op: "tools.install" }, 300_000);
  await viewer.request({ op: "controller", deviceId, controller: "human" });
  await viewer.request({ op: "open_app", deviceId, appId: "com.android.settings" });
  const startedAt = performance.now();
  const started = DeviceState.parse(await viewer.request({ op: "start", deviceId }, 60_000));
  expect(started.lifecycle).toBe("live");
  await viewer.request({ op: "subscribe", deviceId });
  await viewer.request({
    op: "stream.configure",
    deviceId,
    settings: { codec: "h264", maxWidth: 1920, maxHeight: 1920, fps: 60, bitrate: 4_000_000 },
  });
  const first = await viewer.frames(deviceId, { count: 1, keyframes: 1 }, 60_000);
  metrics.firstFrameMs = Math.round((first[0]?.receivedAt ?? NaN) - startedAt);
  const network = "Network & internet";
  await expect.poll(() => shows(viewer, deviceId, network), { timeout: 30_000 }).toBe(true);
  const before = await viewer.frames(deviceId, { keyframes: 1, count: 1, afterMs: 1_500 });

  // A tap opens the network settings, where airplane mode is.
  const entry = await centreOf(viewer, deviceId, network);
  await viewer.request({ op: "input", deviceId, input: { kind: "tap", ...entry } });
  await expect.poll(() => shows(viewer, deviceId, "Airplane mode"), { timeout: 30_000 }).toBe(true);
  const tapped = await viewer.frames(deviceId, { count: before.length + 1, afterMs: 1_500 });

  // Typing reaches the focused field: the settings search box, once its text field is up.
  await viewer.request({ op: "input", deviceId, input: { kind: "key", key: "back" } });
  await waitToShow(viewer, deviceId, "Search");
  const search = await centreOf(viewer, deviceId, "Search");
  await viewer.request({ op: "input", deviceId, input: { kind: "tap", ...search } });
  // A slow emulator can take a while to show the field; tap it when it is there.
  let field: Awaited<ReturnType<typeof firstOfRole>>;
  for (let tries = 0; tries < 10 && !field; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    field = await firstOfRole(viewer, deviceId, "EditText");
  }
  if (field)
    await viewer.request({
      op: "input",
      deviceId,
      input: {
        kind: "tap",
        x: Math.round(field.bounds.x + field.bounds.w / 2),
        y: Math.round(field.bounds.y + field.bounds.h / 2),
      },
    });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await viewer.request({ op: "input", deviceId, input: { kind: "type", text: "zebra42" } });
  await waitToShow(viewer, deviceId, "zebra42");

  // What the person watched is H.264 that decodes at the device's size and followed along.
  expect(tapped.every((frame) => frame.codec.startsWith("avc1."))).toBe(true);
  const decoded = await decode(tapped);
  expect(decoded.length).toBe(tapped.length);
  expect(at(decoded, 0).key).toBe(true);
  for (const [index, frame] of decoded.entries())
    expect({ width: frame.width, height: frame.height }).toEqual({
      width: tapped[index]?.width,
      height: tapped[index]?.height,
    });
  expect(at(decoded, 0).height).toBeGreaterThan(at(decoded, 0).width);
  expect(changed(at(decoded, before.length - 1), at(decoded, -1))).toBeGreaterThan(0.02);

  // Frame rate while the screen keeps moving: back on the settings list, scrolled up and down.
  await viewer.request({ op: "input", deviceId, input: { kind: "key", key: "back" } });
  await viewer.request({ op: "input", deviceId, input: { kind: "key", key: "back" } });
  const { width, height } = at(decoded, 0);
  const scale = at(tapped, 0).scale;
  const x = Math.round(width / scale / 2);
  const [top, bottom] = [Math.round(height / scale / 4), Math.round((height / scale) * 0.75)];
  const counted = (await viewer.frames(deviceId, { count: 1 })).length;
  const cpuBefore = emulatorCpuSeconds();
  const windowStart = performance.now();
  for (let round = 0; round < 4; round++)
    for (const [from, to] of [
      [bottom, top],
      [top, bottom],
    ] as const)
      await viewer.request({
        op: "input",
        deviceId,
        input: { kind: "swipe", x, y: from, toX: x, toY: to, durationMs: 600 },
      });
  const windowSeconds = (performance.now() - windowStart) / 1000;
  const cpuAfter = emulatorCpuSeconds();
  const moving = (await viewer.frames(deviceId, { count: 1 })).slice(counted);
  metrics.scrollFps = Math.round((moving.length / windowSeconds) * 10) / 10;
  metrics.emulatorCpuPercent =
    cpuBefore === undefined || cpuAfter === undefined
      ? undefined
      : Math.round(((cpuAfter - cpuBefore) / windowSeconds) * 100);
  expect(moving.length).toBeGreaterThan(0);

  // A screenshot is the device's own still at its size.
  const shot = DeviceScreenshot.parse(await viewer.request({ op: "screenshot", deviceId }));
  expect(shot.height).toBeGreaterThan(shot.width);
}

/** An agent's device tools on the same device: list, start, screenshot and the UI tree. */
async function agentReads(ace: EvalWorld, deviceId: string) {
  const { agent } = await ace.agent({ prompt: "check the Android device" });
  const listed = await agent.call("sim_list", {});
  expect(listed.failed, listed.text).toBe(false);
  expect(listed.text).toContain(deviceId);
  const started = await agent.call("sim_start", { simId: deviceId });
  expect(started.failed, started.text).toBe(false);
  const shot = await agent.call("sim_screenshot", { simId: deviceId });
  expect(shot.failed, shot.text).toBe(false);
  expect(shot.images).toBe(1);
  const tree = await agent.call("sim_ui", { simId: deviceId });
  expect(tree.failed, tree.text).toBe(false);
  expect(tree.text).toMatch(/"ref":\s*"@?e\d+"/);
}

describe.skipIf(!enabled || !!bootAvd)("Android on Linux, a booted device", () => {
  it("a person sees the booted device listed, watches its H.264 and drives it by tap and typing", async () => {
    const ace = await world();
    const viewer = await devicesViewer(ace);
    const inventory = DeviceInventory.parse(await viewer.request({ op: "list" }));
    // On arm64 with no emulator installed, the list says once that there are no emulators.
    expect(
      inventory.issues.filter((issue) => !/emulators aren't available/.test(issue.message)),
    ).toEqual([]);
    const device = inventory.devices.find((entry) => entry.serial === serial);
    if (!device) throw new Error(`No Android device ${serial}: ${JSON.stringify(inventory)}`);
    expect(device).toMatchObject({ platform: "android", state: "booted" });
    await personDrives(viewer, device.id, {});
  }, 420_000);

  it("an agent reads the Android device's screen and tree with its device tools", async () => {
    const ace = await world();
    // The person turned devices on, as they do once in the app.
    const viewer = await devicesViewer(ace);
    const inventory = DeviceInventory.parse(await viewer.request({ op: "list" }));
    const device = inventory.devices.find((entry) => entry.serial === serial);
    if (!device) throw new Error(`No Android device ${serial}: ${JSON.stringify(inventory)}`);
    await viewer.request({ op: "tools.install" }, 300_000);
    await agentReads(ace, device.id);
  }, 420_000);
});

describe.skipIf(!enabled || !bootAvd)("Android on Linux, an emulator ace boots", () => {
  it("a shut-down AVD boots headless through ace, streams, takes input and serves its tools", async () => {
    const metrics: Metrics = { gpu: process.env.ACE_ANDROID_EMULATOR_GPU ?? "default" };
    try {
      const ace = await world();
      const viewer = await devicesViewer(ace);
      const listed = DeviceInventory.parse(await viewer.request({ op: "list" }));
      const avd = listed.devices.find((entry) => entry.name === bootAvd);
      expect(avd, JSON.stringify(listed)).toMatchObject({ platform: "android", state: "shutdown" });
      const deviceId = avd?.id ?? "";
      await viewer.request({ op: "controller", deviceId, controller: "human" });
      const bootStart = performance.now();
      await viewer.request({ op: "boot", deviceId }, 600_000);
      metrics.bootMs = Math.round(performance.now() - bootStart);
      const booted = DeviceInventory.parse(await viewer.request({ op: "list" }));
      const running = booted.devices.find((entry) => entry.id === deviceId);
      expect(running).toMatchObject({
        state: "booted",
        serial: expect.stringMatching(/^emulator-\d+$/),
      });
      metrics.renderer = renderer(running?.serial ?? "");
      const cpu = emulatorCpuSeconds();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const idle = emulatorCpuSeconds();
      metrics.idleCpuPercent =
        cpu === undefined || idle === undefined ? undefined : Math.round(((idle - cpu) / 5) * 100);
      await personDrives(viewer, deviceId, metrics);
      await viewer.request({ op: "controller", deviceId, controller: "none" });
      await agentReads(ace, deviceId);
      metrics.result = "passed";
    } catch (error) {
      metrics.result = `failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    } finally {
      console.log(`android-metrics ${JSON.stringify(metrics)}`);
      if (artifacts)
        writeFileSync(join(artifacts, "android-metrics.json"), JSON.stringify(metrics, null, 2));
    }
  }, 900_000);
});
