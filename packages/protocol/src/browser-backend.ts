import { z } from "zod";
import { BrowserOpen } from "./browser.ts";
const id = z.string().min(1).max(256);
export const BrowserBackendKind = z.enum(["embedded", "headless"]);
export const BrowserBackendPreference = z.enum(["auto", "embedded", "headless"]);
export const BrowserBackendLossPolicy = z.enum(["pause", "headless"]);
export const BrowserControllerLease = z.object({
  generation: z.number().int().nonnegative(),
  controller: z.enum(["agent", "human", "none"]),
  owner: id.optional(),
});
export type BrowserControllerLease = z.infer<typeof BrowserControllerLease>;
export const BrowserBackendCapabilities = z.object({
  cdp: z.literal(true),
  targets: z.literal(true),
  permissions: z.literal(true),
  downloads: z.literal(true),
  controllerLease: z.literal(true),
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
    lease: BrowserControllerLease,
  }),
  z.object({
    kind: z.literal("cdp"),
    method: id,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().max(8192),
    timeout: z.number().int().min(1).max(30_000),
  }),
  z.object({ kind: z.literal("press"), key: id }),
  z.object({
    kind: z.literal("resize"),
    width: z.number().int().min(100).max(4096),
    height: z.number().int().min(100).max(4096),
  }),
  z.object({ kind: z.literal("controller"), lease: BrowserControllerLease }),
  z.object({ kind: z.literal("close") }),
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
export const BrowserBackendClientMessage = z.discriminatedUnion("type", [
  BrowserBackendRegister,
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
