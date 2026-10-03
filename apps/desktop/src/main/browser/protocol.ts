/**
 * The embedded browser backend wire contract, version 1 (ADR 0055).
 *
 * MIRROR: the daemon side owns these schemas in `packages/protocol/src/browser-backend.ts` on
 * `feat/browser-backends` (PR #74). That branch does not merge cleanly into `feat/desktop`
 * yet, so this module copies its schemas verbatim (unchanged through aad6c738) and is the only place the
 * desktop defines them.
 *
 * TODO(feat/browser-backends): once PR #74 is on main, delete this file's schema bodies and
 * re-export `BrowserBackend*`, `BrowserControllerLease` and `DeviceCredential` from
 * `@ace/protocol`; then switch `relay.process.test.ts` to a static `EmbeddedBackend` import.
 */
import { z } from "zod";
import { BrowserOpen, DeviceId } from "@ace/protocol";

const id = z.string().min(1).max(256);

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

/** Desktop → daemon. */
export const BrowserBackendClientMessage = z.discriminatedUnion("type", [
  BrowserBackendRegister,
  BrowserBackendResponse,
  BrowserBackendEvent,
]);
export type BrowserBackendClientMessage = z.infer<typeof BrowserBackendClientMessage>;

/** Daemon → desktop. */
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

/**
 * `browser-desktop.json` in the daemon's ACE_HOME: a `DeviceCredential` whose device has the
 * `desktop` scope. Only the fields the desktop uses are read, so this stays valid while the
 * `@ace/protocol` on main does not know the `desktop` scope yet.
 */
export const DesktopCredential = z.object({
  device: z.object({ id: DeviceId }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesktopCredential = z.infer<typeof DesktopCredential>;

/** Relay limits from ADR 0055. */
export const relayLimits = {
  /** Any one command, result or event, serialized. */
  messageBytes: 1024 * 1024,
  /** One encoded screencast frame. */
  frameBytes: 768 * 1024,
  sessions: 8,
} as const;
