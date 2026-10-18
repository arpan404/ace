import { z } from "zod";
import { BrowserOpen, browserWaitLimitMs } from "./browser.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
const id = z.string().min(1).max(256);
/** Browser pages one desktop backend hosts at once; the daemon's own page limit matches it. */
export const browserSessionLimit = 32;
export const BrowserBackendKind = z.enum(["embedded", "headless", "user"]);
export const BrowserBackendPreference = z.enum(["auto", "embedded", "headless"]);
export const BrowserBackendLossPolicy = z.enum(["pause", "headless"]);
export const BrowserBackendCapabilities = z.object({
  cdp: z.literal(true),
  targets: z.literal(true),
  permissions: z.literal(true),
  downloads: z.literal(true),
  /** The desktop reports the person's own input on its views (`ace.humanInput` events). */
  humanInput: z.literal(true),
});
export const BrowserBackendRegister = z.object({
  type: z.literal("browser.backend.register"),
  requestId: id,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.literal(1),
  capabilities: BrowserBackendCapabilities,
});
export const BrowserBackendOperation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open"),
    options: BrowserOpen,
    downloadDir: z.string().min(1).max(8192).optional(),
    viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  }),
  z.object({
    kind: z.literal("cdp"),
    method: id,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().max(8192),
    timeout: z.number().int().min(1).max(browserWaitLimitMs),
  }),
  z.object({ kind: z.literal("press"), key: id }),
  z.object({
    kind: z.literal("resize"),
    width: z.number().int().min(100).max(4096),
    height: z.number().int().min(100).max(4096),
  }),
  /**
   * An agent is (or stopped) using the shown tab: the view then intercepts file choosers for
   * it and keeps rendering while unseen. People and agents share the view either way.
   */
  z.object({ kind: z.literal("agentUse"), active: z.boolean() }),
  z.object({ kind: z.literal("close") }),
  /**
   * The thread was deleted: drop its persistent partition, closing its view first. Not tied
   * to an open session; `sessionId` is a fresh id for this request alone.
   */
  z.object({ kind: z.literal("purge"), threadId: ThreadId, workspaceId: WorkspaceId }),
]);
export type BrowserBackendOperation = z.infer<typeof BrowserBackendOperation>;
const session = z.object({ backendId: id, sessionId: id });
export const BrowserBackendRequest = session.extend({
  type: z.literal("browser.backend.request"),
  id,
  operation: BrowserBackendOperation,
});
export type BrowserBackendRequest = z.infer<typeof BrowserBackendRequest>;
export const BrowserBackendResponse = session.extend({
  type: z.literal("browser.backend.response"),
  id,
  result: z.unknown().optional(),
  error: z.string().max(2048).optional(),
});
export const BrowserBackendEvent = session.extend({
  type: z.literal("browser.backend.event"),
  method: id,
  params: z.unknown(),
});
/** The desktop's computer woke from sleep: the daemon checks every browser engine (#947). */
export const BrowserBackendResumed = z.object({ type: z.literal("browser.backend.resumed") });
export const BrowserBackendClientMessage = z.discriminatedUnion("type", [
  BrowserBackendRegister,
  BrowserBackendResumed,
  BrowserBackendResponse,
  BrowserBackendEvent,
]);
export type BrowserBackendClientMessage = z.infer<typeof BrowserBackendClientMessage>;
export const BrowserBackendServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.backend.registered"),
    requestId: id,
    backendId: id,
    connectionId: id,
  }),
  BrowserBackendRequest,
  session.extend({ type: z.literal("browser.backend.frameAck"), frameId: z.number().int() }),
]);
export type BrowserBackendServerMessage = z.infer<typeof BrowserBackendServerMessage>;
export { BrowserBackendLost, BrowserDownloadProgress } from "./browser.ts";
