/*
 * Android on Linux end to end: a person's device view and an agent's device tools on a real
 * booted Android device, through the real daemon. On Linux the picture is scrcpy's device-side
 * H.264 (no host encoding); ffmpeg decodes what the viewer received. No provider CLI or model.
 * Opt-in only: `ACE_ANDROID_E2E_SDK` names an Android SDK folder whose `platform-tools/adb`
 * reaches a booted emulator (`emulator-5554`). `apps/daemon/scripts/linux-e2e/android.sh` sets
 * it, against a real emulator or, on arm64 Linux where Google ships none, a stand-in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DeviceInventory, DeviceScreenshot, DeviceState } from "@ace/protocol/devices";
import { ScreenUITreeResult } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { at, changed, decodeH264 } from "./testing/decode-h264.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";

const sdk = process.env.ACE_ANDROID_E2E_SDK;
const enabled = process.platform === "linux" && !!sdk;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

function decode(frames: readonly ViewerFrame[]) {
  const directory = process.env.ACE_E2E_ARTIFACTS;
  return decodeH264(
    frames.map((frame) => frame.bytes),
    directory ? { directory, name: "android" } : undefined,
  );
}

async function world(): Promise<EvalWorld> {
  // The daemon reads the SDK location from its environment, as it does for a person.
  if (sdk) process.env.ANDROID_HOME = sdk;
  const created = await evalWorld({ browser: false });
  cleanups.push(() => created.close());
  return created;
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

/** Whether any element on screen shows `text`. */
async function shows(viewer: LiveViewer, deviceId: string, text: string): Promise<boolean> {
  const found = ScreenUITreeResult.parse(
    await viewer.request({ op: "ui.find", deviceId, query: { text }, limit: 1 }),
  );
  return found.nodes.length > 0;
}

describe.skipIf(!enabled)("Android on Linux", () => {
  it("a person sees the booted device listed, watches its H.264 and drives it by tap and typing", async () => {
    const ace = await world();
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath, "devices");
    cleanups.push(() => viewer.close());
    await viewer.request({ op: "enable", enabled: true });
    const inventory = DeviceInventory.parse(await viewer.request({ op: "list" }));
    expect(inventory.issues).toEqual([]);
    const device = inventory.devices.find(
      (entry) => entry.platform === "android" && entry.state === "booted",
    );
    if (!device) throw new Error(`No booted Android device: ${JSON.stringify(inventory)}`);
    expect(device.serial).toBe("emulator-5554");
    const deviceId = device.id;

    // The device tools (the scrcpy server) download once, then the live view starts.
    await viewer.request({ op: "tools.install" }, 300_000);
    await viewer.request({ op: "controller", deviceId, controller: "human" });
    await viewer.request({ op: "open_app", deviceId, appId: "com.android.settings" });
    const started = DeviceState.parse(await viewer.request({ op: "start", deviceId }));
    expect(started.lifecycle).toBe("live");
    await viewer.request({ op: "subscribe", deviceId });
    await viewer.request({
      op: "stream.configure",
      deviceId,
      settings: { codec: "h264", maxWidth: 1920, maxHeight: 1920, fps: 30, bitrate: 4_000_000 },
    });
    const network = "Network & internet";
    await expect.poll(() => shows(viewer, deviceId, network), { timeout: 15_000 }).toBe(true);
    const before = await viewer.frames(deviceId, { keyframes: 1, count: 1, afterMs: 1_500 });

    // A tap opens the network settings, where airplane mode is.
    const entry = await centreOf(viewer, deviceId, network);
    await viewer.request({ op: "input", deviceId, input: { kind: "tap", ...entry } });
    await expect
      .poll(() => shows(viewer, deviceId, "Airplane mode"), { timeout: 15_000 })
      .toBe(true);
    const tapped = await viewer.frames(deviceId, { count: before.length + 1, afterMs: 1_500 });

    // Typing reaches the focused field: the settings search box.
    await viewer.request({ op: "input", deviceId, input: { kind: "key", key: "back" } });
    await expect.poll(() => shows(viewer, deviceId, "Search"), { timeout: 15_000 }).toBe(true);
    const search = await centreOf(viewer, deviceId, "Search");
    await viewer.request({ op: "input", deviceId, input: { kind: "tap", ...search } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await viewer.request({ op: "input", deviceId, input: { kind: "type", text: "zebra42" } });
    await expect.poll(() => shows(viewer, deviceId, "zebra42"), { timeout: 15_000 }).toBe(true);

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

    // A screenshot is the device's own still at its size.
    const shot = DeviceScreenshot.parse(await viewer.request({ op: "screenshot", deviceId }));
    expect(shot.height).toBeGreaterThan(shot.width);
  }, 420_000);

  it("an agent reads the Android device's screen and tree with its device tools", async () => {
    const ace = await world();
    // The person turned devices on, as they do once in the app.
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath, "devices");
    cleanups.push(() => viewer.close());
    await viewer.request({ op: "enable", enabled: true });
    const { agent } = await ace.agent({ prompt: "check the Android device" });
    const listed = await agent.call("sim_list", {});
    expect(listed.failed, listed.text).toBe(false);
    const simId = /"id":\s*"(android:[^"]+)"/.exec(listed.text)?.[1];
    if (!simId) throw new Error(`No Android device in:\n${listed.text}`);
    const started = await agent.call("sim_start", { simId });
    expect(started.failed, started.text).toBe(false);
    const shot = await agent.call("sim_screenshot", { simId });
    expect(shot.failed, shot.text).toBe(false);
    expect(shot.images).toBe(1);
    const tree = await agent.call("sim_ui", { simId });
    expect(tree.failed, tree.text).toBe(false);
    expect(tree.text).toMatch(/"ref":\s*"@?e\d+"/);
  }, 300_000);
});
