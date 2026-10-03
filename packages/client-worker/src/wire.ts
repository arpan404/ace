import { z } from "zod";

/*
 * Messages between a tab and the worker that runs `@ace/client` (ADR 0050). Both ends are the
 * same build of this package on one origin, so envelopes are checked here and payloads that the
 * worker's client already decoded with @ace/protocol schemas are not decoded a second time.
 */

const id = z.number().int().nonnegative();
const ErrorShape = z.object({ code: z.string(), message: z.string() });
export type ErrorShape = z.infer<typeof ErrorShape>;

export const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }),
  z.object({ kind: z.literal("threads") }),
]);
export type Scope = z.infer<typeof Scope>;

export const CallMethod = z.enum([
  "enqueue",
  "command",
  "registry",
  "itemsPage",
  "loadOlder",
  "outputRead",
  "networkOnline",
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
  z.object({ t: z.literal("watchIntent"), id: z.string() }),
  z.object({ t: z.literal("unwatchIntent"), id: z.string() }),
  /** A hidden tab receives nothing until it is visible again; then it gets what changed. */
  z.object({ t: z.literal("visible"), visible: z.boolean() }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("bye") }),
]);
export type TabMessage = z.infer<typeof TabMessage>;

const Patch = z.object({
  k: z.string(),
  v: z.unknown().optional(),
  append: z.string().optional(),
  cut: z.boolean().optional(),
});
export const LeaseChanges = z.object({
  lease: id,
  /** A whole-store copy (ThreadExport or SidebarExport); replaces everything the mirror holds. */
  reset: z.unknown().optional(),
  patches: z.array(Patch).optional(),
});
export type LeaseChanges = z.infer<typeof LeaseChanges>;

export const WorkerMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("attached"), error: ErrorShape.optional() }),
  z.object({ t: z.literal("connection"), state: z.string(), error: ErrorShape.optional() }),
  z.object({ t: z.literal("intent"), id: z.string(), intent: z.unknown().optional() }),
  z.object({ t: z.literal("changes"), leases: z.array(LeaseChanges) }),
  z.object({ t: z.literal("reply"), call: id, value: z.unknown().optional() }),
  z.object({ t: z.literal("failed"), call: id, error: ErrorShape }),
  z.object({ t: z.literal("yield"), call: id, done: z.boolean(), value: z.unknown().optional() }),
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
