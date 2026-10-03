import { z } from "zod";

/**
 * Embedded browser backend frames between the desktop main process and the daemon.
 *
 * PROVISIONAL: the daemon side ("browser backends", feat/browser-backends) is being built in
 * parallel. When it lands, these schemas move to `@ace/protocol` and this file re-exports
 * them; the names and shapes here are the desktop's proposal for that contract.
 */
const Id = z.string().min(1).max(200);
const Json = z.record(z.string(), z.unknown());
/** CDP payloads larger than this are refused rather than buffered. */
export const maxPayloadBytes = 4 * 1024 * 1024;

export const BackendCapabilities = z.object({
  screencast: z.boolean(),
  input: z.boolean(),
  takeover: z.boolean(),
});

/** Desktop → daemon. */
export const BackendUp = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.backend.register"),
    backend: z.literal("embedded"),
    version: z.literal(1),
    capabilities: BackendCapabilities,
    /** Sessions still alive here after a reconnect, so the daemon can reattach them. */
    sessions: z.array(z.object({ sessionId: Id, url: z.string() })).max(256),
  }),
  z.object({
    type: z.literal("browser.backend.unregister"),
    reason: z.enum(["quit", "disabled"]),
  }),
  z.object({ type: z.literal("browser.backend.opened"), sessionId: Id, url: z.string() }),
  z.object({
    type: z.literal("browser.backend.closed"),
    sessionId: Id,
    reason: z.enum(["requested", "crashed", "quit"]),
  }),
  z.object({
    type: z.literal("browser.backend.result"),
    sessionId: Id,
    callId: z.number().int().min(0),
    result: Json.optional(),
    error: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal("browser.backend.event"),
    sessionId: Id,
    method: z.string().max(200),
    params: Json,
  }),
  /** Latest screencast frame; older unacknowledged frames are dropped, never queued. */
  z.object({
    type: z.literal("browser.backend.frame"),
    sessionId: Id,
    seq: z.number().int().min(0),
    data: z.string(),
    metadata: Json,
  }),
  z.object({
    type: z.literal("browser.backend.controller"),
    sessionId: Id,
    controller: z.enum(["agent", "human"]),
  }),
  z.object({
    type: z.literal("browser.backend.origin"),
    sessionId: Id,
    requestId: z.number().int().min(0),
    origin: z.string().max(2048),
  }),
]);
export type BackendUp = z.infer<typeof BackendUp>;

/** Daemon → desktop. */
export const BackendDown = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.backend.open"),
    sessionId: Id,
    workspaceId: Id,
    threadId: Id.optional(),
    url: z.string().max(8192).optional(),
  }),
  z.object({ type: z.literal("browser.backend.close"), sessionId: Id }),
  z.object({
    type: z.literal("browser.backend.call"),
    sessionId: Id,
    callId: z.number().int().min(0),
    method: z.string().max(200),
    params: Json.default({}),
  }),
  z.object({ type: z.literal("browser.backend.screencast"), sessionId: Id, enabled: z.boolean() }),
  z.object({ type: z.literal("browser.backend.ack"), sessionId: Id, seq: z.number().int() }),
  z.object({ type: z.literal("browser.backend.handback"), sessionId: Id }),
  z.object({
    type: z.literal("browser.backend.originDecision"),
    sessionId: Id,
    requestId: z.number().int().min(0),
    allowed: z.boolean(),
  }),
]);
export type BackendDown = z.infer<typeof BackendDown>;

/** An authenticated, reconnecting frame channel to the daemon (the desktop link's socket). */
export interface FrameChannel {
  send(frame: BackendUp): void;
  /** Frames from the daemon; called with already-parsed JSON. */
  onFrame(listener: (frame: unknown) => void): () => void;
  /** Fires on every (re)connection once the daemon has accepted the hello. */
  onReady(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
}
