import { z } from "zod";
// ace-media's JSON parser refuses lone UTF-16 surrogates, so every string, including those
// inside free-form fields, must be well-formed Unicode on this side too.
const text = z.string().refine((value) => value.isWellFormed());
const id = text.refine((value) => Array.from(value).length <= 64);
const wellFormed = (value: unknown): boolean => {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([key, item]) => key.isWellFormed() && wellFormed(item));
  return true;
};
const wellFormedJson = z.unknown().refine(wellFormed);
const u32 = z.number().int().min(0).max(0xffffffff);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Admission = z.discriminatedUnion("kind", [
  /** The paired credential's generation: an opaque string (a hash), compared for equality only. */
  z.strictObject({ kind: z.literal("pairing"), generation: id }),
  z.strictObject({ kind: z.literal("account"), account: id }),
]);
const Origin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tab") }),
  z.strictObject({ kind: z.literal("tab-pictures") }),
  z.strictObject({ kind: z.literal("user-tab") }),
  z.strictObject({ kind: z.literal("embedded") }),
  z.strictObject({ kind: z.literal("screen"), platform: text }),
  /** A screen whose helper sends only JPEG: ace-media encodes its pictures (X2). */
  z.strictObject({ kind: z.literal("screen-pictures"), platform: text }),
  z.strictObject({ kind: z.literal("simulator"), streamUrl: text, stillUrl: text }),
  z.strictObject({ kind: z.literal("scrcpy"), host: text, port: u32 }),
  z.strictObject({
    kind: z.literal("emulator-frames"),
    path: text,
    width: u32,
    height: u32,
    stride: u32,
  }),
]);
const Owner = z.strictObject({ session: id, device: id, admission: Admission });
/**
 * Who a viewer's pictures are for, in the client's own ids (D1): what ace-media writes into each
 * stream piece's header and reads back from the client's acks.
 */
const ViewerTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser"), threadId: id, tabId: id.optional() }),
  z.strictObject({ kind: z.literal("screen"), sessionId: id }),
  z.strictObject({ kind: z.literal("device"), deviceId: id }),
]);
export type ViewerTarget = z.infer<typeof ViewerTarget>;
const Settings = z.strictObject({
  recordings: z.enum(["auto", "legacy"]),
  stills: z.enum(["auto", "legacy"]),
  /** Phase 2 removed the daemon's own encoders: ace-media always encodes. */
  encode: z.literal("auto"),
  delivery: z.enum(["auto", "legacy"]),
});
const Remote = z.strictObject({
  addresses: z.array(text),
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
/**
 * What a client says about its link (ADR 0149, K3): the client's word, bounded by type. It only
 * picks a viewer's starting step and never raises a rate above what the link has measured.
 * Strict, unlike the lenient client-facing `MediaLinkHint` (`@ace/protocol`): the daemon builds
 * this field by field from the parsed client hint, dropping absent fields, and never passes the
 * client's object through, or an extra field from a newer client would fail `viewer.open`.
 */
const LinkHint = z.strictObject({
  /** `navigator.connection.effectiveType`; an open string, so a later value parses. */
  effectiveType: id.optional(),
  downlinkKbps: u32.optional(),
  rttMs: u32.optional(),
  /** `Save-Data`, or `navigator.connection.saveData`. */
  saveData: z.boolean().optional(),
  /** iOS `NWPath.isExpensive`. */
  expensive: z.boolean().optional(),
  /** iOS `NWPath.isConstrained` (Low Data Mode). */
  constrained: z.boolean().optional(),
});
const EncodeSpec = z.strictObject({
  id: u32,
  codec: text,
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
  codec: text.optional(),
  backend: Backend,
  hardware: z.boolean(),
  zeroCopy: z.boolean(),
  state: z.enum(["ok", "timed-out", "failed"]),
  maxWidth: u32,
  maxHeight: u32,
});
/** The steps a source runs, with picture-sized GPU↔CPU copies per frame (per still for stills). */
const SourceStep = z.strictObject({
  step: Step,
  backend: Backend,
  hardware: z.boolean(),
  readbacks: u32,
  uploads: u32,
});
const Acceleration = z.strictObject({
  steps: z.array(SourceStep),
  degraded: z.boolean(),
  reason: text.optional(),
});
const Ingest = z.strictObject({ socket: text, websocketPort: u32 });
const Control = z.strictObject({ socket: text });
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
  path: text,
  index: u32,
  bytes: sequence,
  durationMs: sequence,
  gaps: u32,
});
export const ToMedia = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("init"),
    protocol: z.literal(1),
    version: text,
    runtimeDir: text,
    dataDir: text,
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
    /** Whether `epoch` is private (M8): sent for JPEG sources, which open only on a build that
     * agreed to `picture-ingest`. */
    private: z.boolean().optional(),
    origin: Origin,
  }),
  z.strictObject({
    type: z.literal("source.page"),
    source: id,
    width: u32,
    height: u32,
    scale: z.number().finite().nonnegative(),
  }),
  z.strictObject({ type: z.literal("source.codecs"), source: id, codecs: z.array(text) }),
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
    recording: id,
    seq: sequence,
    decided: u32,
    clear: z.array(z.tuple([u32, u32]).refine(([a, b]) => a <= b)),
    discard: z.array(z.tuple([u32, u32]).refine(([a, b]) => a <= b)),
  }),
  z.strictObject({ type: z.literal("source.close"), source: id }),
  /** An ingest barrier (X1): answered by `source.synced` once ace-media took `frames` frames
   * from the source's producer since its hello and its recording decided epoch `decided`. */
  z.strictObject({
    type: z.literal("source.sync"),
    source: id,
    seq: sequence,
    frames: sequence,
    decided: u32,
  }),
  z.strictObject({ type: z.literal("source.egress"), source: id, on: z.boolean() }),
  z.strictObject({
    type: z.literal("source.encodes"),
    source: id,
    encodes: z.array(EncodeSpec),
  }),
  z.strictObject({ type: z.literal("source.key"), source: id, encode: u32 }),
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
    target: ViewerTarget,
    codecs: z.array(text),
    viewport: Viewport,
    local: z.boolean(),
    audio: z.boolean(),
    link: LinkHint.optional(),
  }),
  z.strictObject({
    type: z.literal("viewer.configure"),
    viewer: id,
    viewport: Viewport,
    audio: z.boolean(),
  }),
  z.strictObject({ type: z.literal("viewer.close"), viewer: id }),
  /** The view is hidden or backgrounded: nothing goes to it until `viewer.resume`. */
  z.strictObject({ type: z.literal("viewer.pause"), viewer: id }),
  /** The view shows again; its first picture is a keyframe. */
  z.strictObject({ type: z.literal("viewer.resume"), viewer: id }),
  /** The main session's smoothed round trip and queued bytes, every 500 ms (K3). */
  z.strictObject({
    type: z.literal("session.link"),
    session: id,
    rttMs: u32,
    backlogBytes: sequence,
  }),
  z.strictObject({ type: z.literal("relay.dial"), stream: id, url: text }),
  z.strictObject({ type: z.literal("relay.out"), stream: id }),
  z.strictObject({ type: z.literal("relay.pull"), stream: id }),
  z.strictObject({
    type: z.literal("relay.keys"),
    stream: id,
    connection: id,
    owner: Owner,
    issued: sequence,
  }),
  z.strictObject({ type: z.literal("relay.close"), id: id, stream: id, reason: text }),
  z.strictObject({
    type: z.literal("connection.close"),
    id: id,
    connection: id,
    reason: text,
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
    directory: text,
    maxBytes: sequence,
    pointerTrack: z.boolean(),
  }),
  z.strictObject({ type: z.literal("record.cut"), recording: id, reason: z.enum(["size"]) }),
  z.strictObject({
    type: z.literal("record.meta"),
    recording: id,
    epoch: u32,
    data: wellFormedJson,
  }),
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
    /** The newest public epoch the daemon announced (M8): no still from a picture before it. */
    minEpoch: u32.optional(),
  }),
  /**
   * A poster for a subscribe reply (ADR 0149): the source's picture fitted to the box at
   * 10–20 KB, answered like `still.take` with `still.done` (the JPEG) or `still.failed`.
   */
  z.strictObject({
    type: z.literal("still.poster"),
    request: id,
    source: id,
    width: u32,
    height: u32,
    deadlineMs: u32,
    /** The epochs decided clear: a poster comes only from a picture whose every epoch is in one. */
    clear: z.array(z.tuple([u32, u32]).refine(([a, b]) => a <= b)),
  }),
]);
export type ToMedia = z.infer<typeof ToMedia>;
export const FromMedia = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    protocol: z.literal(1),
    version: text,
    pid: u32,
    capabilities: z.array(Capability),
    ingest: Ingest,
    control: Control,
    listen: Listen,
    /** What ace-media agreed to speak of the features the daemon offered at spawn
     * (`ACE_MEDIA_FEATURES`); absent when none were offered. */
    features: z.array(text).optional(),
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
  /** A producer's ingest connection presented the source's token and was bound to it. */
  z.strictObject({ type: z.literal("source.ingest"), source: id }),
  /** The barrier `source.sync` asked for holds. */
  z.strictObject({ type: z.literal("source.synced"), source: id, seq: sequence }),
  z.strictObject({
    type: z.literal("source.status"),
    source: id,
    status: z.enum(["starting", "playing", "retrying", "ended"]),
    reason: text.optional(),
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
  z.strictObject({ type: z.literal("connection.closed"), connection: id, reason: text }),
  z.strictObject({
    type: z.literal("grant.refused"),
    kind: text,
    id: id,
    reason: z.enum(["owner", "revoked", "expired", "unknown-connection"]),
  }),
  z.strictObject({ type: z.literal("relay.dialed"), stream: id }),
  z.strictObject({ type: z.literal("relay.failed"), stream: id, reason: text }),
  z.strictObject({ type: z.literal("relay.in"), stream: id }),
  z.strictObject({
    type: z.literal("record.part"),
    recording: id,
    path: text,
    index: u32,
    bytes: sequence,
    durationMs: sequence,
    gaps: u32,
  }),
  z.strictObject({ type: z.literal("record.done"), recording: id, parts: z.array(Part) }),
  z.strictObject({ type: z.literal("record.failed"), recording: id, reason: text }),
  z.strictObject({
    type: z.literal("still.done"),
    request: id,
    width: u32,
    height: u32,
    /** The path the still took, step by step, with its picture-sized copies. */
    steps: z.array(SourceStep),
  }),
  z.strictObject({ type: z.literal("still.failed"), request: id, reason: text }),
  z.strictObject({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: text,
    fields: wellFormedJson,
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
/**
 * Whether a frame `decodeFromMedia` refused is a well-formed message of a type this build
 * doesn't know (a newer ace-media's): it is skipped, never fatal. A known type that is malformed
 * still is.
 */
export function unknownFromMedia(bytes: Uint8Array, lane: ControlLane): boolean {
  try {
    const { message } = decodeControl(bytes, lane);
    if (typeof message !== "object" || message === null || !("type" in message)) return false;
    const { type } = message;
    return typeof type === "string" && !fromMediaTypes.has(type);
  } catch {
    return false;
  }
}
const fromMediaTypes: ReadonlySet<string> = new Set(
  FromMedia.options.map((option) => option.shape.type.value),
);

/**
 * Optional features this daemon speaks, offered to ace-media at spawn (`ACE_MEDIA_FEATURES`); a
 * binary that knows one lists it in `ready.features`, and only then is it used.
 */
export const mediaFeatures = ["source.ingest", "source.sync", "picture-ingest"] as const;
export type MediaFeature = (typeof mediaFeatures)[number];

export function decodeToMedia(
  bytes: Uint8Array,
  lane: ControlLane,
): { message: ToMedia; payload: Uint8Array } {
  const frame = decodeControl(bytes, lane),
    message = ToMedia.parse(frame.message);
  validatePayload(message, frame.payload, lane);
  return { message, payload: frame.payload };
}
