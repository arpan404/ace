// Instrument the actual Devices canvas and binary stream without replacing its renderer.
const record: {
  frames: number;
  codecs: Record<string, number>;
  capture: number[];
  source: number[];
  inputs: Record<"tap" | "swipe" | "type", number[]>;
  requests: unknown[];
  errors: unknown[];
  acknowledgements: { at: number; ack: boolean; inputAt: number; kind: string }[];
} = {
  frames: 0,
  codecs: {},
  capture: [],
  source: [],
  inputs: { tap: [], swipe: [], type: [] },
  requests: [],
  errors: [],
  acknowledgements: [],
};
let active = false;
let canvas: HTMLCanvasElement;
let context: CanvasRenderingContext2D;
let inputAt = 0;
let armed = false;
let beforeSamples = 0;
let inputKind: "tap" | "swipe" | "type" = "tap";
let lastAck: boolean | undefined;
let clockRow: { y: number; width: number; height: number } | undefined;
let capturedAt = 0;
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
      if (ack !== lastAck) record.acknowledgements.push({ at: now, ack, inputAt, kind: inputKind });
      const configuredOffset: unknown = Reflect.get(globalThis, "deviceSourceOffset");
      const sourceOffset =
        typeof configuredOffset === "number" && Number.isFinite(configuredOffset)
          ? configuredOffset
          : 0;
      const latency = (((now - sourceOffset) % 2 ** 32) - time + 2 ** 32) % 2 ** 32;
      if (latency < 5000) record.source.push(latency);
      if (inputAt && lastAck !== undefined && ack !== lastAck) {
        record.inputs[inputKind]?.push(now - inputAt);
        inputAt = 0;
      }
      lastAck = ack;
      clockRow = { y: offsetY + y, width, height };
      return;
    }
  }
}
const OriginalSocket = WebSocket;
class MeterSocket extends OriginalSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const message: unknown = JSON.parse(event.data);
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "devices.result" &&
            "ok" in message &&
            message.ok === false
          )
            record.errors.push(message);
        } catch {
          /* not a device response */
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 4) return;
      const length = new DataView(bytes.buffer).getUint32(0);
      if (length > 4096 || length + 4 > bytes.length) return;
      try {
        const h: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4)));
        if (typeof h !== "object" || h === null || !("codec" in h) || typeof h.codec !== "string")
          return;
        if (active) record.codecs[h.codec] = (record.codecs[h.codec] ?? 0) + 1;
        if ("ts" in h && typeof h.ts === "number") capturedAt = h.ts;
        else if ("timestamp" in h && typeof h.timestamp === "number") capturedAt = h.timestamp;
      } catch {
        /* not a frame */
      }
    });
  }
  override send(data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string") {
      try {
        const v: unknown = JSON.parse(data);
        if (typeof v === "object" && v !== null && "operation" in v) {
          const r = v.operation;
          if (typeof r === "object" && r !== null && "op" in r && r.op === "stream.configure")
            record.requests.push(r);
          // Start at actual UI dispatch, excluding Playwright locator/actionability waits.
          if (armed && typeof r === "object" && r !== null && "op" in r && r.op === "input") {
            inputAt = Date.now();
            armed = false;
          }
        }
      } catch {
        /* not a request */
      }
    }
    super.send(data);
  }
}
Reflect.set(globalThis, "WebSocket", MeterSocket);
const draw = CanvasRenderingContext2D.prototype.drawImage;
let painting = false;
CanvasRenderingContext2D.prototype.drawImage = function (
  image: CanvasImageSource,
  ...coordinates: number[]
) {
  Reflect.apply(draw, this, [image, ...coordinates]);
  if (
    !active ||
    !(this.canvas instanceof HTMLCanvasElement) ||
    !this.canvas.getAttribute("aria-label")?.endsWith(" screen") ||
    painting
  )
    return;
  canvas = this.canvas;
  context =
    canvas.getContext("2d") ??
    (() => {
      throw new Error("Device canvas missing");
    })();
  painting = true;
  requestAnimationFrame(() => {
    painting = false;
    if (!active) return;
    record.frames++;
    record.capture.push(Date.now() - capturedAt);
    pixels();
  });
};
Reflect.set(globalThis, "deviceMeter", {
  start() {
    active = true;
  },
  input(kind: typeof inputKind) {
    inputKind = kind;
    inputAt = 0;
    armed = true;
    beforeSamples = record.inputs[kind].length;
  },
  acknowledged() {
    return record.inputs[inputKind].length > beforeSamples;
  },
  stop() {
    active = false;
    return record;
  },
});
