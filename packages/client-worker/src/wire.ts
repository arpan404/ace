// zod/mini: the tab parses every worker message on its first paint path, and mini is a fraction of
// classic Zod's size.
import * as z from "zod/mini";

/*
 * Messages between a tab and the worker that runs `@ace/client` (ADR 0056). Both ends are the
 * same build of this package on one origin, so envelopes are checked here and payloads that the
 * worker's client already decoded with @ace/protocol schemas are not decoded a second time.
 */

const id = z.number().check(z.int(), z.nonnegative());
const ErrorShape = z.object({ code: z.string(), message: z.string() });
export type ErrorShape = z.infer<typeof ErrorShape>;

export const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().check(z.minLength(1)) }),
  z.object({ kind: z.literal("threads") }),
]);
export type Scope = z.infer<typeof Scope>;

export const CallMethod = z.enum([
  "threadsWindow",
  "threadsMore",
  "enqueue",
  "command",
  "registry",
  "itemsPage",
  "turnsPage",
  "itemsWindow",
  "threadSearch",
  "threadCatchUp",
  "threadReadState",
  "markThreadRead",
  "loadOlder",
  "outputRead",
  "networkOnline",
  "request",
]);
export type CallMethod = z.infer<typeof CallMethod>;
export const IterateMethod = z.enum(["text", "output"]);
export type IterateMethod = z.infer<typeof IterateMethod>;

export const TabMessage = z.discriminatedUnion("t", [
  /** Attach to the client for this daemon target, creating it if no other tab has. */
  z.object({ t: z.literal("connect"), config: z.unknown() }),
  z.object({ t: z.literal("lease"), lease: id, scope: Scope }),
  z.object({ t: z.literal("release"), lease: id }),
  z.object({ t: z.literal("call"), call: id, method: CallMethod, args: z.array(z.unknown()) }),
  z.object({
    t: z.literal("iterate"),
    call: id,
    method: IterateMethod,
    args: z.array(z.unknown()),
  }),
  z.object({ t: z.literal("next"), call: id }),
  z.object({ t: z.literal("return"), call: id }),
  z.object({ t: z.literal("abort"), call: id }),
  /** A one-way service control (frame ACK, terminal credit); no reply, never queued. */
  z.object({ t: z.literal("send"), message: z.unknown() }),
  z.object({ t: z.literal("watchPendingSends") }),
  z.object({ t: z.literal("unwatchPendingSends") }),
  z.object({ t: z.literal("watchIntent"), id: z.string() }),
  z.object({ t: z.literal("unwatchIntent"), id: z.string() }),
  /** Forward the client's uncorrelated service messages (such as `settings.changed`). */
  z.object({ t: z.literal("watchMessages") }),
  z.object({ t: z.literal("unwatchMessages") }),
  /** A hidden tab receives nothing until it is visible again; then it gets what changed. */
  z.object({ t: z.literal("visible"), visible: z.boolean() }),
  z.object({ t: z.literal("ping") }),
  /** The tab holds this Web Lock for its lifetime; the worker drops it once the lock frees. */
  z.object({ t: z.literal("alive"), lock: z.string().check(z.minLength(1)) }),
  z.object({ t: z.literal("bye") }),
]);
export type TabMessage = z.infer<typeof TabMessage>;

const Patch = z.object({
  k: z.string(),
  v: z.optional(z.unknown()),
  append: z.optional(z.string()),
  cut: z.optional(z.boolean()),
});
export const LeaseChanges = z.object({
  lease: id,
  /** A whole-store copy (ThreadExport or SidebarExport); replaces everything the mirror holds. */
  reset: z.optional(z.unknown()),
  patches: z.optional(z.array(Patch)),
});
export type LeaseChanges = z.infer<typeof LeaseChanges>;

export const WorkerMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("attached"),
    error: z.optional(ErrorShape),
    idPrefix: z.optional(z.string()),
  }),
  z.object({ t: z.literal("connection"), state: z.string(), error: z.optional(ErrorShape) }),
  z.object({
    t: z.literal("pendingSends"),
    reset: z.optional(z.boolean()),
    entries: z.array(z.unknown()),
    removed: z.array(z.string()),
  }),
  z.object({ t: z.literal("intent"), id: z.string(), intent: z.optional(z.unknown()) }),
  /** An uncorrelated service message the worker's client already decoded. */
  z.object({ t: z.literal("message"), message: z.unknown() }),
  z.object({ t: z.literal("changes"), leases: z.array(LeaseChanges) }),
  z.object({ t: z.literal("reply"), call: id, value: z.optional(z.unknown()) }),
  z.object({ t: z.literal("failed"), call: id, error: ErrorShape }),
  z.object({
    t: z.literal("yield"),
    call: id,
    done: z.boolean(),
    value: z.optional(z.unknown()),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

/** The part of MessagePort both ends use. Node's MessagePort and the DOM's both fit. */
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}
