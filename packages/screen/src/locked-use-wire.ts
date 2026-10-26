/*
 * The wire between the daemon and `ace-screen-helper --locked-use`: frames, the service's
 * messages and the daemon's requests. Each frame is a 4-byte big-endian payload length, then
 * that many bytes (1 to 65,536) of UTF-8 JSON. A bad length poisons the stream: the connection
 * must close. Service messages are read leniently: unknown fields are kept, unknown types are
 * reported as unknown, never fatal.
 */
import { z } from "zod";

export const maxLockedUseFrame = 65_536;

export class LockedUseFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockedUseFrameError";
  }
}

export function encodeLockedUseFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength === 0) throw new LockedUseFrameError("Empty locked use frame");
  if (payload.byteLength > maxLockedUseFrame)
    throw new LockedUseFrameError(`Locked use frame of ${payload.byteLength} bytes is too large`);
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, 4);
  return frame;
}

/** Splits a byte stream into frames. After a bad length every later push throws. */
export class LockedUseFrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #poisoned = false;

  push(chunk: Uint8Array): Buffer[] {
    if (this.#poisoned) throw new LockedUseFrameError("Locked use stream is poisoned");
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    const frames: Buffer[] = [];
    let offset = 0;
    while (this.#buffer.length - offset >= 4) {
      const length = this.#buffer.readUInt32BE(offset);
      if (length === 0 || length > maxLockedUseFrame) {
        this.#poisoned = true;
        this.#buffer = Buffer.alloc(0);
        throw new LockedUseFrameError(`Invalid locked use frame length ${length}`);
      }
      if (this.#buffer.length - offset - 4 < length) break;
      frames.push(Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + length)));
      offset += 4 + length;
    }
    this.#buffer = offset ? Buffer.from(this.#buffer.subarray(offset)) : this.#buffer;
    return frames;
  }
}

export const LockedUsePhase = z.enum([
  "disabled",
  "ready",
  "covering",
  "authorizing",
  "unlocking",
  "working",
  "relocking",
  "manualUnlockRequired",
  "faulted",
]);
export type LockedUsePhase = z.infer<typeof LockedUsePhase>;

export const LockedUseSessionState = z.enum(["locked", "unlocked", "unavailable"]);

const u32 = z.number().int().min(0).max(0xffff_ffff);

export const LockedUseInstallation = z.looseObject({
  pluginSigned: z.boolean(),
  ruleReachesMechanism: z.boolean(),
  lockOnDisplaySleep: z.boolean(),
  brokerLinked: z.boolean(),
  guardianLinked: z.boolean(),
  verified: z.boolean(),
});

export const LockedUseServiceStatus = z.looseObject({
  phase: LockedUsePhase,
  session: LockedUseSessionState,
  userID: u32.nullish(),
  sessionID: u32.nullish(),
  attemptID: z.string().nullish(),
  installation: LockedUseInstallation,
});
export type LockedUseServiceStatus = z.infer<typeof LockedUseServiceStatus>;

const WireError = z.looseObject({ code: z.string(), message: z.string() });

const version = z.literal(1).optional();

const Reply = z.union([
  z.looseObject({
    v: version,
    type: z.literal("reply"),
    id: z.string(),
    ok: z.literal(true),
    status: LockedUseServiceStatus.optional(),
  }),
  z.looseObject({
    v: version,
    type: z.literal("reply"),
    id: z.string(),
    ok: z.literal(false),
    error: WireError,
  }),
]);

const State = z.looseObject({
  v: version,
  type: z.literal("state"),
  status: LockedUseServiceStatus,
});

const Completion = z.looseObject({
  v: version,
  type: z.literal("completion"),
  attemptID: z.string(),
  threadID: z.string(),
  turnID: z.string(),
  reason: z.string(),
  workError: z.string().nullable().optional(),
});

const ErrorEvent = z.looseObject({
  v: version,
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  attemptID: z.string().nullish(),
});

const Known = z.union([Reply, State, Completion, ErrorEvent]);

export type LockedUseReply = z.infer<typeof Reply>;
export type LockedUseEvent =
  | z.infer<typeof State>
  | z.infer<typeof Completion>
  | z.infer<typeof ErrorEvent>;
export type LockedUseMessage =
  | z.infer<typeof Known>
  | { type: "unknown"; raw: Record<string, unknown> };

const Envelope = z.looseObject({ type: z.string(), v: z.unknown().optional() });

/**
 * Reads one service frame. A message of an unknown type or version comes back as `unknown`
 * with its raw fields; a known type with unusable fields, or anything that is not a JSON
 * object, is malformed and returns undefined.
 */
export function decodeLockedUseMessage(frame: Uint8Array): LockedUseMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    return undefined;
  }
  const envelope = Envelope.safeParse(value);
  if (!envelope.success) return undefined;
  const known = ["reply", "state", "completion", "error"].includes(envelope.data.type);
  const current = envelope.data.v === undefined || envelope.data.v === 1;
  if (!known || !current) return { type: "unknown", raw: envelope.data };
  const parsed = Known.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface LockedUseScope {
  userID: number;
  sessionID: number;
  threadID: string;
  turnID: string;
  attemptID: string;
}

/**
 * What the daemon sends. `hello` must be a connection's first frame. `enable` and `begin`
 * carry the person's opt-in: only `optIn: true` on the wire counts, and it is sent exactly
 * when the person's `computer.lockedUse` setting is on.
 */
export type LockedUseRequest =
  | { type: "hello"; token: string }
  | { type: "status" | "disable" }
  | { type: "enable"; optIn: boolean }
  | { type: "begin"; scope: LockedUseScope; agentProcessIDs: readonly number[]; optIn: boolean }
  | { type: "finish" | "cancel"; attemptID: string };

function body(id: string, request: LockedUseRequest): Record<string, unknown> {
  switch (request.type) {
    case "enable":
      return { v: 1, id, type: request.type, ...(request.optIn ? { optIn: true } : {}) };
    case "begin":
      return {
        v: 1,
        id,
        type: request.type,
        scope: request.scope,
        agentProcessIDs: [...request.agentProcessIDs],
        ...(request.optIn ? { optIn: true } : {}),
      };
    default:
      return { v: 1, id, ...request };
  }
}

/** One request as a frame. `id` is 1 to 64 characters and comes back in the reply. */
export function encodeLockedUseRequest(id: string, request: LockedUseRequest): Buffer {
  if (id.length < 1 || id.length > 64) throw new LockedUseFrameError("Invalid request id");
  return encodeLockedUseFrame(new TextEncoder().encode(JSON.stringify(body(id, request))));
}
