import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Data one agent sends another (ADR 0182): a parcel is one file or text, staged and hashed on
 * the sending machine, carried in bounded chunks over whatever path reaches the other machine
 * (LAN, Tailscale, a relay) and checked against its SHA-256 before the receiving agent is told.
 * Nothing here carries a credential.
 */

/** A parcel's id, chosen by the sending machine. */
export const ParcelId = z.string().regex(/^pcl-[a-f0-9-]{36}$/);
export type ParcelId = z.infer<typeof ParcelId>;

/** One parcel is at most 1 GiB. */
export const maxParcelBytes = 1024 * 1024 * 1024;
/** Bytes per chunk: base64 of it fits a machine call's body with room for its other fields. */
export const parcelChunkBytes = 192 * 1024;
/** A note the sender adds, shown to the receiving agent. */
export const maxParcelNoteChars = 2000;

/**
 * A parcel's file name: one path segment, no control characters, never `.` or `..`. Received
 * parcels are written under this name only inside their own folder.
 */
export const ParcelName = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !/[/\\]/.test(name) &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(name),
    "Expected a file name without folders or control characters",
  )
  .meta({
    "x-ace-constraint": "One path segment: not . or .., no / or \\, no control characters.",
    examples: ["dataset.csv"],
  });
export type ParcelName = z.infer<typeof ParcelName>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Offset = z.int().min(0).max(maxParcelBytes);
/** Base64 of at most one chunk. */
const ChunkData = z
  .string()
  .max(Math.ceil(parcelChunkBytes / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** What a parcel is, as both machines record it. */
export const ParcelFacts = z.strictObject({
  parcelId: ParcelId,
  name: ParcelName,
  size: z.int().min(0).max(maxParcelBytes),
  sha256: Sha256,
  note: z.string().max(maxParcelNoteChars).optional(),
  /** The sending thread's title, so the receiving agent knows who sent it. */
  fromTitle: z.string().max(256),
});
export type ParcelFacts = z.infer<typeof ParcelFacts>;

/**
 * The `parcel` machine call. The calling machine is always the one holding the link:
 * - `offer`, `chunk`, `commit`, `cancel` push a parcel to a thread it delegated there;
 * - `outbox`, `read`, `ack` pull what a thread delegated there sent back to its parent.
 * Each is idempotent under its parcel id, so a call lost on one path is sent again on another.
 */
export const ParcelCall = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("offer"), to: ThreadId, parcel: ParcelFacts }),
  z.strictObject({
    action: z.literal("chunk"),
    parcelId: ParcelId,
    offset: Offset,
    data: ChunkData,
  }),
  z.strictObject({ action: z.literal("commit"), parcelId: ParcelId }),
  z.strictObject({ action: z.literal("cancel"), parcelId: ParcelId }),
  z.strictObject({ action: z.literal("outbox") }),
  z.strictObject({
    action: z.literal("read"),
    parcelId: ParcelId,
    offset: Offset,
    length: z.int().min(1).max(parcelChunkBytes),
  }),
  z.strictObject({
    action: z.literal("ack"),
    parcelId: ParcelId,
    outcome: z.enum(["delivered", "refused"]),
    reason: z.string().max(400).optional(),
  }),
]);
export type ParcelCall = z.infer<typeof ParcelCall>;

/** Where an incoming parcel stands on the receiving machine. */
export const ParcelState = z.enum(["receiving", "delivered", "cancelled"]);
export type ParcelState = z.infer<typeof ParcelState>;

/** A parcel a delegated thread here sent to its parent on the calling machine. */
export const OutboxParcel = z.strictObject({
  /** The delegated thread here that sent it. */
  from: ThreadId,
  /** Its parent on the calling machine. */
  to: ThreadId,
  parcel: ParcelFacts,
});
export type OutboxParcel = z.infer<typeof OutboxParcel>;

/** The target's answer to a `parcel` call. */
export const ParcelAnswer = z.union([
  /** offer, chunk, commit, cancel: how many bytes it holds durably and where the parcel stands. */
  z.strictObject({ state: ParcelState, offset: Offset }),
  z.strictObject({ outbox: z.array(OutboxParcel).max(16) }),
  z.strictObject({ data: ChunkData, offset: Offset }),
  z.strictObject({ acknowledged: z.literal(true) }),
]);
export type ParcelAnswer = z.infer<typeof ParcelAnswer>;

/** A parcel as the agent tools list it. */
export const ParcelView = z.strictObject({
  parcelId: ParcelId,
  direction: z.enum(["sent", "received"]),
  name: ParcelName,
  size: z.int().min(0),
  sha256: Sha256,
  state: z.enum(["sending", "waiting", "delivered", "failed", "cancelled", "received"]),
  /** The other thread, and its machine when it isn't this one. */
  peer: z.strictObject({ threadId: ThreadId, machine: z.string().max(64).optional() }),
  note: z.string().max(maxParcelNoteChars).optional(),
  /** Received: where the verified bytes are kept, read-only. */
  path: z.string().max(4096).optional(),
  error: z.string().max(400).optional(),
});
export type ParcelView = z.infer<typeof ParcelView>;
