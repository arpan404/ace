/*
 * A live iOS Simulator watched through the end-to-end encrypted relay on the shared media
 * stream (#1118): bytes, pictures and delay from the daemon's capture to the viewer, idle and
 * while the screen moves. Non-gating and manual: it creates, boots and deletes its own
 * simulator and needs Xcode and serve-sim. `node apps/daemon/bench/device-relay.ts [seconds]`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DevicePlatform, DevicesService } from "@ace/devices";
import { DeviceClient, deviceTransport, ephemeralRelayKeys } from "@ace/client/devices";
import { deviceStreamProfile, type DevicePicture } from "@ace/client/devices";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { startRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { Store } from "../src/store.ts";
import { RemoteAuth } from "../src/remote-auth.ts";
import { startFilesRelay } from "../src/files-relay.ts";

const seconds = Number(process.argv[2] ?? 10);
const root = await mkdtemp(join(tmpdir(), "ace-device-relay-bench-"));
const udid = execFileSync(
  "xcrun",
  ["simctl", "create", "ace-relay-bench", "com.apple.CoreSimulator.SimDeviceType.iPhone-16"],
  {
    encoding: "utf8",
  },
).trim();
const deviceId = `ios:${udid}`;
const cleanup: (() => unknown)[] = [
  () => execFileSync("xcrun", ["simctl", "delete", udid]),
  () => execFileSync("xcrun", ["simctl", "shutdown", udid], { stdio: "ignore" }),
];
const schedule = (callback: () => void, ms: number) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
try {
  const store = new Store(join(root, "store.sqlite"));
  cleanup.push(() => store.close());
  const auth = new RemoteAuth(store.devices, "bench-local-token", {
    now: Date.now,
    secret: randomUUID,
  });
  const admin = auth.redeem(auth.pairing(["admin"]).code, "bench");
  let id = 0;
  const service = new DevicesService({
    platform: new DevicePlatform({ platform: process.platform, home: homedir(), env: process.env }),
    runtime: {
      now: Date.now,
      id: () => `bench-${++id}`,
      spawn: spawnRawSupervised,
      after: (ms, run) => schedule(run, ms),
    },
    env: process.env,
    recordingDirectory: root,
    async publishArtifact() {},
  });
  cleanup.push(() => service.close());
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    auth,
    devices: store.devices,
    appDevices: service,
    store,
    hostId: "bench-host",
    headSeq: () => 0,
  });
  cleanup.push(() => host.close());

  const client = new DeviceClient({ id: randomUUID, schedule });
  const ready = Promise.withResolvers<void>();
  client.watch((snapshot) => {
    if (snapshot.connected) ready.resolve();
  });
  client.connect(
    deviceTransport({
      target: { kind: "relay", url: relay.url, pinnedFingerprint: fingerprint(keys.publicKey) },
      expectedHostId: "bench-host",
      deviceId: admin.device.id,
      credential: async () => admin.token,
      socket: (url) => new WebSocket(url) as never,
      keys: ephemeralRelayKeys,
      schedule,
    }),
  );
  await ready.promise;
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  await client.request({ op: "controller", deviceId, controller: "human" });
  await client.request({ op: "boot", deviceId });
  await client.request({ op: "start", deviceId, fps: 30 });

  let bytes = 0;
  let pictures = 0;
  /** H.264 deltas no later picture refers to (nal_ref_idc 0): what fps decimation could drop. */
  let disposable = 0;
  let deltas = 0;
  const delays: number[] = [];
  const codecs = new Set<string>();
  client.watchPictures(deviceId, async (picture: DevicePicture) => {
    bytes += picture.bytes.length;
    pictures++;
    codecs.add(picture.codec);
    if (picture.codec !== "jpeg" && !picture.key) {
      deltas++;
      if (unreferenced(picture.bytes)) disposable++;
    }
    delays.push(Date.now() - picture.timestamp);
    client.ack(picture);
  });
  client.retainStream(deviceId);
  const profile = deviceStreamProfile({ width: 390 * 2, height: 844 * 2 }, "relay");
  await client.request({ op: "stream.configure", deviceId, settings: profile });

  const measure = async (label: string, during?: () => Promise<void>) => {
    bytes = 0;
    pictures = 0;
    disposable = 0;
    deltas = 0;
    delays.length = 0;
    const started = performance.now();
    const run = { moving: true };
    const motion = during
      ? (async () => {
          while (run.moving) await during();
        })()
      : undefined;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    run.moving = false;
    await motion;
    const elapsed = (performance.now() - started) / 1000;
    const sorted = delays.toSorted((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    process.stdout.write(
      `${label}: ${((bytes * 8) / elapsed / 1e6).toFixed(2)} Mbit/s, ${(pictures / elapsed).toFixed(1)} pictures/s, ` +
        `capture→viewer delay p50 ${at(0.5)} ms p95 ${at(0.95)} ms, codecs ${[...codecs].join(",")}, ` +
        `disposable deltas ${disposable}/${deltas}\n`,
    );
  };
  // Let the first keyframe and the profile settle.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await measure("idle home screen");
  let left = true;
  await measure("paging the home screen", async () => {
    await client.request({
      op: "input",
      deviceId,
      input: left
        ? { kind: "swipe", x: 340, y: 400, toX: 40, toY: 400, durationMs: 250 }
        : { kind: "swipe", x: 40, y: 400, toX: 340, toY: 400, durationMs: 250 },
    });
    left = !left;
  });
  client.disconnect();
} finally {
  for (const close of cleanup.toReversed()) {
    try {
      await close();
    } catch {
      /* best effort */
    }
  }
  await rm(root, { recursive: true, force: true });
}

/** Whether every slice in an Annex B access unit has nal_ref_idc 0. */
function unreferenced(unit: Uint8Array): boolean {
  let slices = 0;
  for (let at = 0; at + 3 < unit.length; at++) {
    if (unit[at] !== 0 || unit[at + 1] !== 0 || unit[at + 2] !== 1) continue;
    const header = unit[at + 3] ?? 0;
    const type = header & 0x1f;
    if (type === 1 || type === 5) {
      slices++;
      if ((header >> 5) & 3) return false;
    }
  }
  return slices > 0;
}
