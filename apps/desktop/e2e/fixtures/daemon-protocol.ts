import { z } from "zod";
import { BrowserProfileScope, ThreadId, WorkspaceId } from "@ace/protocol";

/**
 * What the e2e specs (on Node) and their daemon (daemon-process.ts, on Bun) say to each other:
 * one JSON request per line on the daemon's stdin, one reply per line on its stdout. Replies
 * carry `marker`, so anything else the daemon prints passes through as output.
 */
export const marker = "ace-e2e-daemon ";

/** The daemon a spec needs. */
export const DaemonProfile = z.discriminatedUnion("kind", [
  /** The browser sandbox's: a real Chromium, the renderer's origin allowed, no provider CLIs. */
  z.object({
    kind: z.literal("sandbox"),
    webOrigin: z.string().url(),
    chromium: z.string().min(1),
    backend: z.enum(["auto", "headless"]),
  }),
  /** The native browser spec's: no headless browser exists, so only the app can host one. */
  z.object({ kind: z.literal("native") }),
]);
export type DaemonProfile = z.infer<typeof DaemonProfile>;

/** The browser service methods the specs call, each answered with its awaited result. */
export const browserMethods = [
  "open",
  "execute",
  "state",
  "input",
  "closeThread",
  "screenshot",
  "disconnect",
] as const;
export type BrowserMethod = (typeof browserMethods)[number];

const id = z.number().int().nonnegative();
export const DaemonRequest = z.discriminatedUnion("op", [
  z.object({ id, op: z.literal("workspace"), path: z.string().min(1), name: z.string().min(1) }),
  /** A thread as a client prepares one, marked as sent to so Home lists it. */
  z.object({ id, op: z.literal("thread"), workspaceId: WorkspaceId, title: z.string().min(1) }),
  /** A thread written straight to the store, as development builds create one. */
  z.object({ id, op: z.literal("devThread"), workspaceId: WorkspaceId }),
  z.object({ id, op: z.literal("browser"), method: z.enum(browserMethods), args: z.array(z.unknown()) }),
  /** `browser.profileScope` for browsers opened from now on. */
  z.object({ id, op: z.literal("profileScope"), scope: BrowserProfileScope }),
  /** A remote viewer of the page's live video, kept in the daemon process. */
  z.object({
    id,
    op: z.literal("watchVideo"),
    threadId: ThreadId,
    connectionId: z.string().min(1),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    codecs: z.array(z.string().min(1)).min(1),
  }),
  /** What that viewer has received so far. */
  z.object({ id, op: z.literal("videoSeen"), threadId: ThreadId, connectionId: z.string().min(1) }),
  z.object({ id, op: z.literal("stopVideo"), threadId: ThreadId, connectionId: z.string().min(1) }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

/** What a remote video viewer has received. */
export const VideoSeen = z.object({
  chunks: z.number().int().nonnegative(),
  keyframes: z.number().int().nonnegative(),
});
export type VideoSeen = z.infer<typeof VideoSeen>;

export const DaemonReply = z.union([
  z.object({ ready: z.object({ url: z.string(), tokenPath: z.string() }) }),
  z.object({ id, value: z.unknown() }),
  z.object({ id, error: z.string() }),
]);
export type DaemonReply = z.infer<typeof DaemonReply>;

/** A thread as the specs use it. */
export const SpecThread = z.object({ id: ThreadId, workspaceId: WorkspaceId }).passthrough();
export type SpecThread = z.infer<typeof SpecThread>;

/** Bytes (a screenshot) cross the pipe as base64. */
const Bytes = z.object({ bytes: z.string() });
export function encodeValue(value: unknown): unknown {
  return value instanceof Uint8Array ? { bytes: Buffer.from(value).toString("base64") } : value;
}
export function decodeValue(value: unknown): unknown {
  const bytes = Bytes.strict().safeParse(value);
  return bytes.success ? Buffer.from(bytes.data.bytes, "base64") : value;
}
