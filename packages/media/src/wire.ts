import { z } from "zod";
const id = z.string().refine((value) => value.isWellFormed() && Array.from(value).length <= 64);
const u32 = z.number().int().min(0).max(0xffffffff);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Admission = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pairing"), generation: sequence }),
  z.strictObject({ kind: z.literal("account"), account: id }),
]);
const Origin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tab") }),
  z.strictObject({ kind: z.literal("tab-pictures") }),
  z.strictObject({ kind: z.literal("user-tab") }),
  z.strictObject({ kind: z.literal("embedded") }),
  z.strictObject({ kind: z.literal("screen"), platform: z.string() }),
  z.strictObject({ kind: z.literal("simulator"), streamUrl: z.string(), stillUrl: z.string() }),
  z.strictObject({ kind: z.literal("scrcpy"), host: z.string(), port: u32 }),
  z.strictObject({
    kind: z.literal("emulator-frames"),
    path: z.string(),
    width: u32,
    height: u32,
    stride: u32,
  }),
]);
const Owner = z.strictObject({ session: id, device: id, admission: Admission });
const Settings = z.strictObject({
  recordings: z.enum(["auto", "legacy"]),
  stills: z.enum(["auto", "legacy"]),
  encode: z.enum(["auto", "legacy"]),
  delivery: z.enum(["auto", "legacy"]),
});
const Remote = z.strictObject({
  addresses: z.array(z.string()),
  port: u32,
  certificateBytes: u32,
  keyBytes: u32,
});
const Viewport = z.strictObject({
  width: u32,
  height: u32,
  dpr: z.number().finite().nonnegative(),
  scale: z.number().finite().nonnegative(),
});
const EncodeSpec = z.strictObject({
  id: u32,
  codec: z.string(),
  width: u32,
  height: u32,
  fps: u32,
  bitrate: u32,
  quantizer: u32.optional(),
});
const Step = z.enum(["encode", "decode", "jpeg-decode", "jpeg-encode", "scale"]);
const Backend = z.enum(["vt", "mf", "vaapi", "nv", "chrome", "cpu"]);
/** One probe result (ADR 0148). `codec` is absent for `scale`; sizes are 0 unless `ok`. */
const Capability = z.strictObject({
  step: Step,
  codec: z.string().optional(),
  backend: Backend,
  hardware: z.boolean(),
  zeroCopy: z.boolean(),
  state: z.enum(["ok", "timed-out", "failed"]),
  maxWidth: u32,
  maxHeight: u32,
});
/** The steps a source runs, with picture-sized GPU↔CPU copies per frame (per still for stills). */
const Acceleration = z.strictObject({
  steps: z.array(
    z.strictObject({
      step: Step,
      backend: Backend,
      hardware: z.boolean(),
      readbacks: u32,
      uploads: u32,
    }),
  ),
  degraded: z.boolean(),
  reason: z.string().optional(),
});
const Ingest = z.strictObject({ socket: z.string(), websocketPort: u32 });
const Control = z.strictObject({ socket: z.string() });
const Listen = z.strictObject({ loopbackPort: u32, remotePort: u32.optional() });
const Stats = z.strictObject({
  sources: sequence,
  viewers: sequence,
  connections: sequence,
  cpuMs: sequence,
  rssBytes: sequence,
  bytesOut: sequence,
  priorityLagMs: sequence,
});
const Part = z.strictObject({
  path: z.string(),
  index: u32,
  bytes: sequence,
  durationMs: sequence,
  gaps: u32,
});
export const ToMedia = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("init"),
    protocol: z.literal(1),
    version: z.string(),
    runtimeDir: z.string(),
    dataDir: z.string(),
    settings: Settings,
  }),
  z.strictObject({ type: z.literal("ping"), id: id }),
  z.strictObject({ type: z.literal("shutdown"), graceMs: u32 }),
  z.strictObject({
    type: z.literal("listen"),
    loopback: z.literal(true),
    remote: Remote.optional(),
  }),
  z.strictObject({
    type: z.literal("source.open"),
    source: id,
    handle: u32,
    threadId: id.optional(),
    tabId: id.optional(),
    sessionId: id.optional(),
    deviceId: id.optional(),
    epoch: u32,
    origin: Origin,
  }),
  z.strictObject({
    type: z.literal("source.page"),
    source: id,
    width: u32,
    height: u32,
    scale: z.number().finite().nonnegative(),
  }),
  z.strictObject({ type: z.literal("source.codecs"), source: id, codecs: z.array(z.string()) }),
  z.strictObject({ type: z.literal("source.picture"), source: id, ageMs: u32, epoch: u32 }),
  z.strictObject({
    type: z.literal("source.epoch"),
    source: id,
    seq: sequence,
    epoch: u32,
    followsPrivate: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("record.epochs"),
    source: id,
    seq: sequence,
    decided: u32,
    clear: z.array(z.tuple([u32, u32]).refine(([a, b]) => a <= b)),
    discard: z.array(z.tuple([u32, u32]).refine(([a, b]) => a <= b)),
  }),
  z.strictObject({ type: z.literal("source.close"), source: id }),
  z.strictObject({ type: z.literal("source.egress"), source: id, on: z.boolean() }),
  z.strictObject({
    type: z.literal("media.ticket"),
    connection: id,
    owner: Owner,
    issued: sequence,
    expiresAt: sequence,
  }),
  z.strictObject({
    type: z.literal("viewer.open"),
    viewer: id,
    connection: id,
    owner: Owner,
    issued: sequence,
    source: id,
    codecs: z.array(z.string()),
    viewport: Viewport,
    local: z.boolean(),
    audio: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("viewer.configure"),
    viewer: id,
    viewport: Viewport,
    audio: z.boolean(),
  }),
  z.strictObject({ type: z.literal("viewer.close"), viewer: id }),
  z.strictObject({ type: z.literal("relay.dial"), stream: id, url: z.string() }),
  z.strictObject({ type: z.literal("relay.out"), stream: id }),
  z.strictObject({ type: z.literal("relay.pull"), stream: id }),
  z.strictObject({
    type: z.literal("relay.keys"),
    stream: id,
    connection: id,
    owner: Owner,
    issued: sequence,
  }),
  z.strictObject({ type: z.literal("relay.close"), id: id, stream: id, reason: z.string() }),
  z.strictObject({
    type: z.literal("connection.close"),
    id: id,
    connection: id,
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal("revoke"),
    id: id,
    issued: sequence,
    device: id,
    admission: Admission.optional(),
  }),
  z.strictObject({
    type: z.literal("record.start"),
    recording: id,
    source: id,
    directory: z.string(),
    maxBytes: sequence,
    pointerTrack: z.boolean(),
  }),
  z.strictObject({ type: z.literal("record.cut"), recording: id, reason: z.enum(["size"]) }),
  z.strictObject({ type: z.literal("record.meta"), recording: id, epoch: u32, data: z.unknown() }),
  z.strictObject({ type: z.literal("record.stop"), recording: id }),
  z.strictObject({
    type: z.literal("still.take"),
    request: id,
    source: id,
    maxWidth: u32,
    maxHeight: u32,
    maxPixels: u32,
    quality: u32,
    deadlineMs: u32,
  }),
]);
export type ToMedia = z.infer<typeof ToMedia>;
export const FromMedia = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    protocol: z.literal(1),
    version: z.string(),
    pid: u32,
    capabilities: z.array(Capability),
    ingest: Ingest,
    control: Control,
    listen: Listen,
  }),
  z.strictObject({ type: z.literal("capabilities.changed"), capabilities: z.array(Capability) }),
  z.strictObject({ type: z.literal("pong"), id: id, stats: Stats }),
  z.strictObject({ type: z.literal("revoked"), id: id }),
  z.strictObject({ type: z.literal("closed"), id: id }),
  z.strictObject({ type: z.literal("epoch.applied"), source: id, seq: sequence, epoch: u32 }),
  z.strictObject({
    type: z.literal("epochs.applied"),
    source: id,
    seq: sequence,
    written: sequence,
    dropped: sequence,
  }),
  z.strictObject({
    type: z.literal("source.status"),
    source: id,
    status: z.enum(["starting", "playing", "retrying", "ended"]),
    reason: z.string().optional(),
    attempts: u32.optional(),
    acceleration: Acceleration.optional(),
  }),
  z.strictObject({ type: z.literal("source.want"), source: id, encodes: z.array(EncodeSpec) }),
  z.strictObject({
    type: z.literal("source.keyframe"),
    source: id,
    encode: u32,
    reason: z.enum(["viewer", "drop", "resume"]),
  }),
  z.strictObject({ type: z.literal("source.audio"), source: id, on: z.boolean() }),
  z.strictObject({ type: z.literal("viewer.playing"), viewer: id, playing: z.boolean() }),
  z.strictObject({
    type: z.literal("viewer.stats"),
    viewer: id,
    rate: u32,
    fps: z.number().finite().nonnegative(),
    dropped: sequence,
    rttMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("connection.open"),
    connection: id,
    kind: z.enum(["direct", "relay"]),
    owner: Owner,
  }),
  z.strictObject({ type: z.literal("connection.closed"), connection: id, reason: z.string() }),
  z.strictObject({
    type: z.literal("grant.refused"),
    kind: z.string(),
    id: id,
    reason: z.enum(["owner", "revoked", "expired", "unknown-connection"]),
  }),
  z.strictObject({ type: z.literal("relay.dialed"), stream: id }),
  z.strictObject({ type: z.literal("relay.failed"), stream: id, reason: z.string() }),
  z.strictObject({ type: z.literal("relay.in"), stream: id }),
  z.strictObject({
    type: z.literal("record.part"),
    recording: id,
    path: z.string(),
    index: u32,
    bytes: sequence,
    durationMs: sequence,
    gaps: u32,
  }),
  z.strictObject({ type: z.literal("record.done"), recording: id, parts: z.array(Part) }),
  z.strictObject({ type: z.literal("record.failed"), recording: id, reason: z.string() }),
  z.strictObject({ type: z.literal("still.done"), request: id, width: u32, height: u32 }),
  z.strictObject({ type: z.literal("still.failed"), request: id, reason: z.string() }),
  z.strictObject({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    fields: z.unknown(),
  }),
]);
export type FromMedia = z.infer<typeof FromMedia>;

export type ControlLane = "normal" | "priority";
const priorityTypes = new Set([
  "revoke",
  "connection.close",
  "relay.close",
  "source.epoch",
  "record.epochs",
  "shutdown",
  "revoked",
  "closed",
  "epoch.applied",
  "epochs.applied",
]);
export function controlLane(type: ToMedia["type"] | FromMedia["type"]): ControlLane {
  return priorityTypes.has(type) ? "priority" : "normal";
}
function validatePayload(
  message: ToMedia | FromMedia,
  payload: Uint8Array,
  lane: ControlLane,
): void {
  if (controlLane(message.type) !== lane || (lane === "priority" && payload.length > 256))
    throw new Error("Invalid control lane");
  let length = 0;
  switch (message.type) {
    case "init":
    case "media.ticket":
    case "source.open":
      length = 32;
      break;
    case "relay.keys":
      length = 120;
      break;
    case "listen":
      length = message.remote ? message.remote.certificateBytes + message.remote.keyBytes : 0;
      break;
    case "source.picture":
    case "relay.out":
    case "relay.in":
    case "still.done":
      return;
  }
  if (payload.length !== length) throw new Error("Invalid control payload length");
}
export function encodeControl(
  message: ToMedia | FromMedia,
  payload: Uint8Array,
  lane: ControlLane,
): { header: Uint8Array; payload: Uint8Array } {
  validatePayload(message, payload, lane);
  const json = new TextEncoder().encode(JSON.stringify(message));
  const length = 4 + json.length + payload.length;
  if (length > (lane === "normal" ? 8 * 1024 * 1024 : 64 * 1024))
    throw new Error("Control frame too large");
  const header = new Uint8Array(8 + json.length),
    v = new DataView(header.buffer);
  v.setUint32(0, length);
  v.setUint32(4, json.length);
  header.set(json, 8);
  return { header, payload };
}
function decodeControl(
  bytes: Uint8Array,
  lane: ControlLane,
): { message: unknown; payload: Uint8Array } {
  if (bytes.length < 8) throw new Error("Truncated control header");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    length = v.getUint32(0),
    jsonLength = v.getUint32(4);
  if (
    length < 4 ||
    length > (lane === "normal" ? 8 * 1024 * 1024 : 64 * 1024) ||
    length + 4 !== bytes.length ||
    jsonLength > length - 4
  )
    throw new Error("Invalid control length");
  const message: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + jsonLength)),
  );
  return { message, payload: bytes.subarray(8 + jsonLength) };
}
export function decodeFromMedia(
  bytes: Uint8Array,
  lane: ControlLane,
): { message: FromMedia; payload: Uint8Array } {
  const frame = decodeControl(bytes, lane),
    message = FromMedia.parse(frame.message);
  validatePayload(message, frame.payload, lane);
  return { message, payload: frame.payload };
}
export function decodeToMedia(
  bytes: Uint8Array,
  lane: ControlLane,
): { message: ToMedia; payload: Uint8Array } {
  const frame = decodeControl(bytes, lane),
    message = ToMedia.parse(frame.message);
  validatePayload(message, frame.payload, lane);
  return { message, payload: frame.payload };
}
