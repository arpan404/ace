import { z } from "zod";
import { ItemId, ThreadId } from "./ids.ts";
import { Item } from "./items.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ordinal = count.positive();
const requestId = z.string().min(1).max(256);

/** A site's web origin, `https://github.com`: scheme and host only, never a path or userinfo. */
export const SiteOrigin = z
  .string()
  .max(512)
  .regex(/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/)
  .meta({ "x-ace-constraint": "http(s) origin: scheme, lowercase host and optional port only." });
export type SiteOrigin = z.infer<typeof SiteOrigin>;

/**
 * What a browser or computer-use step acted on, as the daemon can resolve an icon for it: a web
 * site by origin or a native app by its platform identity (a macOS bundle id, a Windows exe path,
 * a Linux WM_CLASS).
 */
export const ToolIcon = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("site"), origin: SiteOrigin }),
  z.object({
    kind: z.literal("app"),
    identity: z.string().min(1).max(1024),
    name: z.string().max(256).optional(),
  }),
]);
export type ToolIcon = z.infer<typeof ToolIcon>;

/** A resolved icon: the SHA-256 of its 64px PNG. Content-addressed, so immutable. */
export const IconRef = z.string().regex(/^[a-f0-9]{64}$/);
export type IconRef = z.infer<typeof IconRef>;

/** The surface a step drove, and the icon that stands for it once the daemon resolved one. */
export const ToolSurface = z.object({
  kind: z.enum(["browser", "computer"]),
  icon: ToolIcon.optional(),
  iconRef: IconRef.optional(),
});
export type ToolSurface = z.infer<typeof ToolSurface>;

/**
 * One of a turn's steps as its work log shows it: the item without its native payloads (`raw`
 * is kept only for `custom` calls, whose arguments live there) and text cut to a preview.
 */
/**
 * A surface as the wire carries it. A kind or icon a client doesn't know still decodes; clients
 * read it with `ToolSurface` and skip what they can't (never fatal to the turn).
 */
export const StepSurface = z.object({
  kind: z.string().max(32),
  icon: z
    .object({ kind: z.string().max(32) })
    .loose()
    .optional(),
  iconRef: IconRef.optional(),
});
export type StepSurface = z.infer<typeof StepSurface>;

export const TurnStep = z.object({
  seq: ordinal,
  item: Item,
  surface: StepSurface.optional(),
});
export type TurnStep = z.infer<typeof TurnStep>;

/** One turn's steps, oldest first, read on demand when its "Worked for" log opens. */
export const TurnStepsRequest = z.object({
  type: z.literal("turn.steps"),
  requestId,
  threadId: ThreadId,
  turnOrdinal: ordinal,
  /** Exclusive creation-seq cursor: the previous page's `after`. */
  after: count.optional(),
  limit: count.min(1).max(200).default(100),
});
export type TurnStepsRequest = z.infer<typeof TurnStepsRequest>;
export const TurnStepsResponse = z.object({
  type: z.literal("turn.steps"),
  requestId,
  threadId: ThreadId,
  turnOrdinal: ordinal,
  seq: count,
  /** The turn's last indexed event; a page read at one `endSeq` never changes. */
  endSeq: count,
  steps: z.array(TurnStep).max(200),
  /** Cursor for the next page, or null at the turn's end. */
  after: ordinal.nullable(),
});
export type TurnStepsResponse = z.infer<typeof TurnStepsResponse>;

/**
 * The icons of a thread's own recorded steps. The daemon reads each step and works out its site
 * or app itself: it never fetches an origin a client names (ADR 0002, no request forgery).
 */
export const IconsResolveRequest = z.object({
  type: z.literal("icons.resolve"),
  requestId,
  threadId: ThreadId,
  itemIds: z.array(ItemId).min(1).max(32),
});
export type IconsResolveRequest = z.infer<typeof IconsResolveRequest>;
/**
 * `found` (with `ref`) names the icon's PNG; `none` says the step has no icon (no surface, or none
 * exists); `later` says the lookup failed in a way that may pass, so ask again later. Clients
 * read any other state as `later`.
 */
export const IconResult = z.object({
  state: z
    .string()
    .max(32)
    .meta({ "x-ace-values": ["found", "none", "later"] }),
  ref: IconRef.optional(),
});
export type IconResult = z.infer<typeof IconResult>;
export const IconsResolveResponse = z.object({
  type: z.literal("icons.resolve"),
  requestId,
  threadId: ThreadId,
  /** One per requested step, in order. */
  icons: z.array(IconResult).max(32),
});
export type IconsResolveResponse = z.infer<typeof IconsResolveResponse>;

/** A resolved icon's bytes. Also served over HTTP at `/v1/icons/<ref>`. */
export const IconsReadRequest = z.object({
  type: z.literal("icons.read"),
  requestId,
  ref: IconRef,
});
export type IconsReadRequest = z.infer<typeof IconsReadRequest>;
export const IconsReadResponse = z.object({
  type: z.literal("icons.read"),
  requestId,
  ref: IconRef,
  mimeType: z.literal("image/png"),
  /** Base64 PNG, at most 64x64 and 48 KiB. */
  data: z
    .string()
    .max(65_536)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type IconsReadResponse = z.infer<typeof IconsReadResponse>;
