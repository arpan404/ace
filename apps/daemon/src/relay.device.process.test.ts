import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService } from "@ace/files";
import { DevicePlatform, DevicesService, type DevicesOptions } from "@ace/devices";
import {
  DeviceClientMessage,
  DeviceInventory,
  DeviceScreenshot,
  DeviceServerMessage,
  DeviceState,
} from "@ace/protocol/devices";
import { DeviceId } from "@ace/protocol";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { framePacket, type Frame } from "@ace/screen";
import {
  decodeStreamMessage,
  isStreamPiece,
  StreamAssembler,
  type StreamMessage,
} from "@ace/browser/stream";
import { Store } from "./store.ts";
import { allows, type Scope } from "./devices.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { startFilesRelay } from "./files-relay.ts";
import { deviceInputProcess } from "./testing/device-input-process.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
type Capture = Parameters<NonNullable<DevicesOptions["capture"]>>[0];
type Result = Extract<DeviceServerMessage, { type: "devices.result" }>;
function image(sessionId: string, sequence: number, byte: number): Frame {
  const payload = Buffer.alloc(128 * 1024, byte);
  const header = {
    version: 1 as const,
    sessionId,
    sequence,
    timestamp: sequence,
    width: 640,
    height: 480,
    codec: "jpeg" as const,
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}

/** Consume JSON state updates and relay stream pieces through the public portable decoder. */
class DeviceClient {
  readonly channel: ClientChannel;
  readonly chunks: number[] = [];
  private readonly pictures: Extract<StreamMessage, { kind: "device.frame" }>[] = [];
  private readonly assembler = new StreamAssembler();
  private sequence = 0;
  constructor(channel: ClientChannel) {
    this.channel = channel;
  }
  async send(operation: unknown): Promise<string> {
    const requestId = `relay-request-${++this.sequence}`;
    await this.channel.send(
      DeviceClientMessage.parse({ type: "devices.request", requestId, operation }),
    );
    return requestId;
  }
  private async next(): Promise<DeviceServerMessage | undefined> {
    const frame = await this.channel.receiveFrame();
    if (frame instanceof Uint8Array) {
      if (this.chunks.length >= 128) throw new Error("Unexpected fragment flood");
      this.chunks.push(frame.length);
      // Every binary message on the devices channel is a stream piece.
      if (!isStreamPiece(frame)) throw new Error("Binary message is not a stream piece");
      const envelope = this.assembler.push(frame);
      const message = envelope && decodeStreamMessage(envelope);
      if (message?.kind === "device.frame") this.pictures.push(message);
      return undefined;
    }
    return DeviceServerMessage.parse(frame);
  }
  async result(requestId: string): Promise<Result> {
    for (;;) {
      const message = await this.next();
      if (message?.type === "devices.result") {
        if (message.requestId !== requestId) throw new Error("Unexpected device result");
        return message;
      }
    }
  }
  async request(operation: unknown): Promise<Result> {
    return this.result(await this.send(operation));
  }
  /** The next device picture that came as stream kind `deviceFrame`. */
  async picture() {
    while (this.pictures.length === 0) {
      const message = await this.next();
      if (message?.type === "devices.result") throw new Error("Unconsumed device result");
    }
    const picture = this.pictures.shift();
    if (!picture) throw new Error("Missing picture");
    return picture;
  }
  async ack(deviceId: string, streamId: string, sequence: number) {
    await this.channel.send({ type: "devices.ack", deviceId, streamId, sequence });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-device-relay-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, "sdk");
  for (const relative of ["platform-tools/adb", "emulator/emulator"]) {
    const path = join(sdk, relative);
    await mkdir(join(path, ".."), { recursive: true });
    // A fake native process stays alive on its supervised stdin, without native tools.
    await writeFile(path, `#!${process.execPath}\nprocess.stdin.resume();\n`);
    await chmod(path, 0o700);
  }
  const store = new Store(join(root, "store.sqlite"));
  cleanup.push(() => store.close());
  const auth = new RemoteAuth(store.devices, "host-local-token", {
    now: () => 1,
    secret: randomUUID,
  });
  const paired = (scopes: Scope[]) => auth.redeem(auth.pairing(scopes).code, scopes.join("-"));
  const admin = paired(["admin"]);
  const reader = paired(["read"]);
  const active = new Map<string, string>([["emulator-5554", "Pixel"]]);
  const inputs: string[] = [];
  const probe: NonNullable<ConstructorParameters<typeof DevicePlatform>[0]["probe"]> = async (
    _command,
    args,
  ) => {
    const command = args.join(" ");
    let stdout = "";
    if (command === "-list-avds") stdout = "Pixel\nTablet\n";
    else if (command === "devices -l")
      stdout =
        "List of devices attached\n" +
        [...active.keys()].map((serial) => `${serial} device`).join("\n");
    else if (command.endsWith("emu avd name")) stdout = `${active.get(args[1] ?? "")}\nOK\n`;
    else if (command.endsWith("wait-for-device")) active.set(args[1] ?? "", "Tablet");
    else if (command.includes("input")) inputs.push(command);
    return { stdout, stderr: "", code: 0 };
  };
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { ANDROID_HOME: sdk },
    probe,
    spawn: deviceInputProcess(probe),
  });
  const captures = new Map<string, Capture>();
  let id = 0;
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: root,
    runtime: {
      now: () => 1,
      id: () => `relay-stream-${++id}`,
      spawn: spawnRawSupervised,
      after: () => () => {},
    },
    async capture(options) {
      captures.set(options.device.id, options);
      options.publish(image(options.streamId, 0, options.device.name === "Pixel" ? 11 : 22));
      return {
        async stop() {
          captures.delete(options.device.id);
        },
      };
    },
    async publishArtifact() {},
  });
  cleanup.push(() => service.close());
  const files = await FilesService.create({
    workspace: root,
    dataDir: join(root, "files"),
    artifactRoots: [root],
    now: () => 1,
    id: randomUUID,
    authorize(deviceId, capability) {
      const device = store.devices.get(deviceId);
      return (
        device?.revokedAt === null &&
        allows(device, capability === "files.read" ? "read" : "operate")
      );
    },
  });
  cleanup.push(() => files.close());
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    files,
    auth,
    devices: store.devices,
    appDevices: service,
    store,
    hostId: "daemon-relay-host",
    headSeq: () => 0,
  });
  cleanup.push(() => host.close());
  async function connect(
    credential = admin,
    channel: "devices" | "files" = "devices",
    token = credential.token,
  ) {
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
    });
    cleanup.push(async () => {
      client.close();
      await client.closed;
    });
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: credential.device.id,
      token,
      channel,
    });
    return client;
  }
  async function connected() {
    const client = await connect();
    expect(await client.receive()).toMatchObject({ type: "welcome", hostId: "daemon-relay-host" });
    return new DeviceClient(client);
  }
  function publish(deviceId: string, sequence: number, byte: number) {
    const capture = captures.get(deviceId);
    if (!capture) throw new Error("Device capture was not started");
    capture.publish(image(capture.streamId, sequence, byte));
  }
  return { service, auth, admin, reader, connect, connected, publish, inputs };
}

async function ready(client: DeviceClient, deviceId: string) {
  expect(await client.request({ op: "controller", deviceId, controller: "human" })).toMatchObject({
    ok: true,
  });
  expect(await client.request({ op: "boot", deviceId })).toMatchObject({
    ok: true,
    data: { completed: true },
  });
  const started = await client.request({ op: "start", deviceId });
  expect(started.ok).toBe(true);
  expect(DeviceState.parse(started.data).lifecycle).toBe("live");
  expect(await client.request({ op: "subscribe", deviceId })).toMatchObject({ ok: true });
}

it("a relay viewer on the shared media stream gets an emulator's pictures at the pace it acks", async () => {
  const f = await fixture();
  const client = await f.connected();
  await client.request({ op: "enable", enabled: true });
  await ready(client, "android:Tablet");
  const first = await client.picture();
  expect(first.sourceId).toBe("android:Tablet");
  expect(first.frame).toMatchObject({ sequence: 0, codec: "jpeg", key: true, width: 640 });
  expect(Buffer.from(first.frame.bytes)).toEqual(Buffer.alloc(128 * 1024, 22));
  // Each 128 KiB picture crossed the relay in pieces no larger than a relay message.
  expect(client.chunks.every((length) => length <= 64 * 1024)).toBe(true);
  const shown = [first];
  for (let sequence = 1; sequence <= 7; sequence++) {
    f.publish("android:Tablet", sequence, 40 + sequence);
    shown.push(await client.picture());
  }
  expect(shown.map((picture) => picture.frame.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  // Eight pictures unacked fill the window: the next ones wait, each replacing the one before.
  f.publish("android:Tablet", 8, 48);
  f.publish("android:Tablet", 9, 49);
  await client.ack("android:Tablet", first.frame.streamId, 7);
  const newest = await client.picture();
  expect(newest.frame.sequence).toBe(9);
  expect(Buffer.from(newest.frame.bytes)).toEqual(Buffer.alloc(128 * 1024, 49));
});

it("a paired phone boots and controls an emulator and reassembles large encrypted device frames", async () => {
  const f = await fixture();
  const client = await f.connected();
  const before = await client.request({ op: "list" });
  expect(
    DeviceInventory.parse(before.data).devices.find((device) => device.id === "android:Tablet")
      ?.state,
  ).toBe("shutdown");
  expect(await client.request({ op: "enable", enabled: true })).toMatchObject({ ok: true });
  await ready(client, "android:Tablet");
  const after = await client.request({ op: "list" });
  expect(
    DeviceInventory.parse(after.data).devices.find((device) => device.id === "android:Tablet"),
  ).toMatchObject({ state: "booted", serial: "emulator-5556" });
  const picture = await client.picture();
  expect(Buffer.from(picture.frame.bytes)).toEqual(Buffer.alloc(128 * 1024, 22));
  expect(client.chunks).toHaveLength(3);
  expect(client.chunks.every((length) => length <= 64 * 1024)).toBe(true);
  expect(
    await client.request({
      op: "input",
      deviceId: "android:Tablet",
      input: { kind: "tap", x: 7, y: 9 },
    }),
  ).toMatchObject({ ok: true });
  expect(f.inputs).toEqual(["-s emulator-5556 shell 'input' 'tap' '7' '9'"]);
});

it("two live device streams and a screenshot keep whole pictures over one encrypted relay channel", async () => {
  const f = await fixture();
  const client = await f.connected();
  await client.request({ op: "enable", enabled: true });
  await ready(client, "android:Pixel");
  const pixel = await client.picture();
  await ready(client, "android:Tablet");
  const tablet = await client.picture();
  const request = await client.send({ op: "screenshot", deviceId: "android:Pixel" });
  f.publish("android:Pixel", 1, 33);
  f.publish("android:Tablet", 1, 44);
  const result = await client.result(request);
  expect(result.ok).toBe(true);
  const pictures = [await client.picture(), await client.picture(), await client.picture()];
  const screenshot = DeviceScreenshot.parse(result.data);
  // The screenshot came as a still, ahead of its result, naming the capture and picture.
  const still = pictures.find((picture) => picture.frame.still);
  expect(still).toMatchObject({
    sourceId: "android:Pixel",
    frame: { streamId: screenshot.streamId, sequence: screenshot.sequence },
  });
  // The screenshot is whichever picture was newest when it was taken.
  expect(Buffer.from(still?.frame.bytes ?? [])).toEqual(
    Buffer.alloc(128 * 1024, screenshot.sequence === 0 ? 11 : 33),
  );
  const live = pictures.filter((picture) => !picture.frame.still);
  expect(
    live.map((picture) => [picture.sourceId, picture.frame.sequence]).toSorted(),
  ).toEqual([
    ["android:Pixel", 1],
    ["android:Tablet", 1],
  ]);
  for (const picture of live)
    expect(Buffer.from(picture.frame.bytes)).toEqual(
      Buffer.alloc(128 * 1024, picture.sourceId === tablet.sourceId ? 44 : 33),
    );
  expect(pixel.frame.streamId).not.toBe(tablet.frame.streamId);
});

it("read-only pairings cannot open the device channel and revocation closes an active controller", async () => {
  const f = await fixture();
  const reader = await f.connect(f.reader);
  await reader.closed;
  expect(f.auth.deviceBearer(f.reader.token)?.scopes).toEqual(["read"]);
  const files = await f.connect(f.reader, "files");
  expect(await files.receive()).toMatchObject({ type: "welcome" });
  await files.send({
    type: "files.request",
    requestId: "read",
    operation: { op: "stat", path: "missing" },
  });
  expect(await files.receive()).toMatchObject({ type: "files.result", value: { version: null } });
  const forged = await f.connect(f.admin, "devices", f.reader.token);
  await forged.closed;
  expect(f.service.states()).toEqual([]);
  const client = await f.connected();
  await client.request({ op: "enable", enabled: true });
  await ready(client, "android:Pixel");
  await client.picture();
  const released = new Promise<void>((resolve) => {
    const unwatch = f.service.watch((state) => {
      if (state.device.id === "android:Pixel" && state.controller === "none") {
        unwatch();
        resolve();
      }
    });
  });
  expect(f.auth.revoke(DeviceId.parse(f.admin.device.id))).toBe(true);
  await client.channel.closed;
  await released;
  expect(f.auth.deviceBearer(f.admin.token)).toBeUndefined();
  expect(f.service.states()[0]?.controller).toBe("none");
  expect(f.inputs).toEqual([]);
});
