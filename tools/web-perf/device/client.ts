import { z } from "zod";
import { AppDeviceId } from "@ace/protocol";
import {
  DeviceClient,
  deviceTransport,
  browserDeviceSocket,
  deviceVideoSupported,
  deviceStreamProfile,
  type DevicePicture,
} from "@ace/client/devices";
// The web app's own live-view renderer and decoder, so the probe measures what people see.
import { pictureRenderer } from "../../../apps/web/src/lib/video/picture-renderer.ts";
import { webCodecsDecoder } from "../../../apps/web/src/lib/video/codecs.ts";

const config = z
  .object({
    url: z.string(),
    token: z.string(),
    deviceId: AppDeviceId,
    fps: z.number().int().min(1).max(60),
    baseline: z.boolean(),
  })
  .parse(Reflect.get(globalThis, "probeConfig"));
const canvas = document.createElement("canvas");
document.body.append(canvas);
const candidate = canvas.getContext("2d", { willReadFrequently: true });
if (!candidate) throw new Error("Canvas missing");
const context = candidate;
const client = new DeviceClient({
  id: () => crypto.randomUUID(),
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
});
const record = {
  latencies: [] as number[],
  capture: [] as number[],
  input: [] as number[],
  bytes: 0,
  frames: 0,
  dispatch: [] as number[],
  errors: [] as string[],
  codecs: { jpeg: 0, h264: 0 },
};
Reflect.set(globalThis, "probeRecord", record);
let inputAt = 0;
let lastAck: boolean | undefined;
let clockRow: { y: number; width: number; height: number } | undefined;
function pixels() {
  const { width, height } = canvas;
  if (clockRow && (clockRow.width !== width || clockRow.height !== height)) clockRow = undefined;
  const offsetY = clockRow?.y ?? Math.floor(height * 0.45);
  const rows = clockRow ? 1 : Math.ceil(height * 0.2);
  const data = context.getImageData(0, offsetY, width, rows).data;
  // Find our red delimiter near the centre. The Simulator bezel/titlebar may change.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width * 0.2; x++) {
      const offset = (y * width + x) * 4;
      if ((data[offset] ?? 0) < 200 || (data[offset + 1] ?? 0) > 60 || (data[offset + 2] ?? 0) > 60)
        continue;
      let end = x;
      while (
        end < width &&
        (data[(y * width + end) * 4] ?? 0) > 200 &&
        (data[(y * width + end) * 4 + 1] ?? 0) < 60
      )
        end++;
      const redCenter = (end + x) / 2;
      let ackStart = end;
      while (ackStart < width) {
        const p = (y * width + ackStart) * 4;
        if ((data[p] ?? 0) < 80 && ((data[p + 1] ?? 0) > 160 || (data[p + 2] ?? 0) > 160)) break;
        ackStart++;
      }
      let ackEnd = ackStart;
      while (ackEnd < width) {
        const p = (y * width + ackEnd) * 4;
        if ((data[p] ?? 0) > 80 || ((data[p + 1] ?? 0) < 160 && (data[p + 2] ?? 0) < 160)) break;
        ackEnd++;
      }
      const cell = ((ackStart + ackEnd) / 2 - redCenter) / 33;
      if (cell < 3 || ackStart === width) continue;
      let time = 0;
      for (let bit = 0; bit < 32; bit++) {
        const p = (y * width + Math.round(redCenter + cell * (bit + 1))) * 4;
        if ((data[p] ?? 0) > 125) time += 2 ** bit;
      }
      const p = (y * width + Math.round(redCenter + cell * 33)) * 4;
      const ack = (data[p + 1] ?? 0) > (data[p + 2] ?? 0);
      const now = Date.now();
      const latency = ((now % 2 ** 32) - time + 2 ** 32) % 2 ** 32;
      if (latency < 5000) record.latencies.push(latency);
      if (inputAt && lastAck !== undefined && ack !== lastAck) {
        record.input.push(now - inputAt);
        inputAt = 0;
      }
      lastAck = ack;
      clockRow = { y: offsetY + y, width, height };
      return;
    }
  }
}
let painting = false;
let capturedAt = 0;
function displayed(picture: DevicePicture) {
  capturedAt = picture.timestamp;
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => {
    painting = false;
    record.capture.push(Date.now() - capturedAt);
    pixels();
    record.frames++;
  });
}
async function draw(next: DevicePicture) {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([next.bytes.slice()], { type: "image/jpeg" }));
  try {
    image.src = url;
    await image.decode();
    canvas.width = next.width;
    canvas.height = next.height;
    context.drawImage(image, 0, 0);
    displayed(next);
  } finally {
    URL.revokeObjectURL(url);
  }
}
client.connect(
  deviceTransport({
    target: { kind: "local", url: config.url },
    deviceId: "perf-probe",
    credential: async () => config.token,
    socket: browserDeviceSocket,
    keys: () => {
      throw new Error("local");
    },
    schedule: (run, ms) => {
      const t = setTimeout(run, ms);
      return () => clearTimeout(t);
    },
  }),
);
client.watch((snapshot) => {
  if (!snapshot.connected) return;
  Reflect.set(globalThis, "probeReady", true);
});
// Live views are H.264 only, as in the app: no JPEG decoder, and no fallback to one.
const renderer = pictureRenderer<DevicePicture>({
  decoder: webCodecsDecoder(),
  show: (image, picture) => {
    canvas.width = picture.width;
    canvas.height = picture.height;
    image.draw(context, picture.width, picture.height);
    displayed(picture);
  },
  ack: (picture, keyframe) => client.ack(picture, keyframe),
  fallback: () => {
    record.errors.push("This browser can't decode H.264 video");
  },
  pressure: () => {},
});
Reflect.set(globalThis, "probeStart", async () => {
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "controller", deviceId: config.deviceId, controller: "human" });
  client.watchPictures(config.deviceId, async (picture) => {
    record.bytes += picture.bytes.length;
    record.codecs[picture.codec === "jpeg" ? "jpeg" : "h264"]++;
    if (config.baseline) {
      await draw(picture);
      client.ack(picture);
    } else await renderer.render(picture);
  });
  await client.request({ op: "start", deviceId: config.deviceId, fps: config.fps });
  await client.request({ op: "subscribe", deviceId: config.deviceId });
  if (!config.baseline && !(await deviceVideoSupported()))
    record.errors.push("This browser can't decode H.264 video");
  else if (!config.baseline)
    await client.request({
      op: "stream.configure",
      deviceId: config.deviceId,
      settings: deviceStreamProfile({ width: 900, height: 1800 }, "local"),
    });
});
Reflect.set(globalThis, "probeTap", async () => {
  if (inputAt) return;
  inputAt = Date.now();
  const before = performance.now();
  const send = (
    input:
      | { kind: "tap"; x: number; y: number }
      | { kind: "pointer"; phase: "down" | "up"; x: number; y: number },
  ) => client.request({ op: "input", deviceId: config.deviceId, input });
  await (
    config.baseline
      ? send({ kind: "tap", x: 100, y: 220 })
      : Promise.all([
          send({ kind: "pointer", phase: "down", x: 100, y: 220 }),
          send({ kind: "pointer", phase: "up", x: 100, y: 220 }),
        ])
  ).catch((e) => record.errors.push(String(e)));
  record.dispatch.push(performance.now() - before);
});

Reflect.set(globalThis, "probeStop", async () => {
  await client.request({ op: "stop", deviceId: config.deviceId });
  client.disconnect();
  renderer.close();
});
