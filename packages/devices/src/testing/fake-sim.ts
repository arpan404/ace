import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  ScreenUIActOptions,
  ScreenUITreeOptions,
  ScreenUITreeResult,
  type ScreenUINode,
} from "@ace/protocol";
import type { AppDevice as Device, DeviceInput } from "@ace/protocol/devices";
import { framePacket, type Frame } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicePlatform } from "../platform.ts";
import { DevicesService } from "../service.ts";
import { DeviceError } from "../sdk.ts";
import { androidFind } from "../android-ui.ts";
import { shotJpeg, type DeviceShot } from "../one-off-screenshot.ts";

/** A UI node for a fake screen: actionable when it lists actions. */
export function fakeNode(
  ref: string,
  role: string,
  name: string,
  bounds: ScreenUINode["bounds"],
  actions: ScreenUINode["actions"] = [],
  children: ScreenUINode[] = [],
): ScreenUINode {
  return { ref, role, name, bounds, states: [], actions, children };
}

/**
 * A device platform with no SDKs behind it: one iOS simulator and one Android emulator whose
 * screens are trees the test sets, and whose inputs and UI actions are recorded as effects. It
 * answers through the same `ui.tree` contract a real platform does, so refs, leases and one-off
 * screenshots run through the real devices service.
 */
export class FakeSimPlatform extends DevicePlatform {
  readonly devices: Device[] = [
    {
      id: "ios:00000000-0000-4000-8000-00000000F00D",
      platform: "ios",
      name: "iPhone Fake",
      state: "booted",
    },
    { id: "android:Pixel_Fake", platform: "android", name: "Pixel Fake", state: "shutdown" },
  ];
  /** The UI each device shows now; tests replace it to change the screen. */
  readonly screens = new Map<string, ScreenUINode[]>();
  /** Inputs and UI actions the devices received, in order. */
  readonly effects: string[] = [];
  /** One-off screenshots taken, by device id. */
  readonly shots: string[] = [];
  constructor(home: string) {
    super({ platform: "linux", home, env: {} });
  }
  override diagnostics() {
    return [];
  }
  override async list(): Promise<Device[]> {
    return this.devices.map((device) => ({ ...device }));
  }
  override async boot(device: Device): Promise<void> {
    const entry = this.devices.find((candidate) => candidate.id === device.id);
    if (entry) entry.state = "booted";
  }
  override async uiTree(device: Device, options: unknown) {
    const { maxNodes } = ScreenUITreeOptions.parse(options);
    const nodes = this.screens.get(device.id) ?? [];
    return ScreenUITreeResult.parse({ nodes, truncated: nodes.length > maxNodes });
  }
  override async uiFind(device: Device, options: unknown) {
    return androidFind(await this.uiTree(device, { maxNodes: 512, maxDepth: 16 }), options);
  }
  override async uiAct(device: Device, options: unknown) {
    const action = ScreenUIActOptions.parse(options);
    const pending = [...(this.screens.get(device.id) ?? [])];
    while (pending.length) {
      const node = pending.pop();
      if (!node) break;
      if (node.ref === action.ref) {
        this.effects.push(
          `${device.id} ui ${action.action} ${node.name}${action.value === undefined ? "" : ` ${JSON.stringify(action.value)}`}`,
        );
        return { fallback: false, method: "fake.ui" };
      }
      pending.push(...node.children);
    }
    throw new DeviceError("stale_ref", "Fake UI target is gone", "Read the UI tree again.");
  }
  override async input(device: Device, input: DeviceInput): Promise<void> {
    this.effects.push(`${device.id} input ${JSON.stringify(input)}`);
  }
  override async screenshot(device: Device): Promise<DeviceShot> {
    this.shots.push(device.id);
    const png = await sharp({
      create: { width: 300, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    return shotJpeg(png);
  }
  override async close(): Promise<void> {}
}

function liveFrame(streamId: string, sequence: number): Frame {
  const payload = Buffer.from(`live-${sequence}`);
  const header = {
    version: 1 as const,
    sessionId: streamId,
    sequence,
    timestamp: sequence,
    width: 100,
    height: 200,
    scale: 1,
    codec: "jpeg" as const,
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}

/** A devices service over the fake platform, with devices on and a capture that goes live. */
export async function fakeSimService(): Promise<{
  service: DevicesService;
  platform: FakeSimPlatform;
  close(): Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "ace-fake-sim-"));
  const platform = new FakeSimPlatform(home);
  let id = 0;
  const service = new DevicesService({
    platform,
    env: {},
    runtime: {
      now: () => 1,
      id: () => `fake-stream-${++id}`,
      spawn: spawnRawSupervised,
      after: () => () => {},
    },
    async capture(options) {
      options.publish(liveFrame(options.streamId, 0));
      return { async stop() {} };
    },
    recordingDirectory: home,
    async publishArtifact() {
      throw new Error("The fake platform does not record");
    },
  });
  await service.request({ op: "enable", enabled: true }, { kind: "human", owner: "person" });
  return {
    service,
    platform,
    async close() {
      await service.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
