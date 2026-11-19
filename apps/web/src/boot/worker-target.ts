import * as z from "zod/mini";
import { DaemonTargetShape } from "./connection-settings.ts";

/** What a tab hands the client worker: the daemon to reach and this device's identity. */
export const WorkerTargetShape = {
  ...DaemonTargetShape,
  deviceId: z.string().check(z.minLength(1)),
  /** This app install (ADR 0115); a worker can't read local storage, so the page passes it. */
  installId: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  /** The outbox an older build kept in localStorage, to carry over once. */
  seed: z.nullable(z.string()),
};
export const WorkerTarget = z.object(WorkerTargetShape);
export type WorkerTarget = z.infer<typeof WorkerTarget>;

/**
 * One client per daemon and device; the token is not part of it. The desktop's own daemon is
 * named by the identity its home names, so a fresh start (a new home and identity at the same
 * address) gets an empty outbox instead of one pinned to the daemon that home replaced. Any
 * other daemon is named by its address, and its outbox stays pinned to the daemon it met.
 */
export const outboxKey = (target: {
  url: string;
  deviceId: string;
  localHostId?: string | undefined;
}) =>
  target.localHostId
    ? `ace.outbox.local.${target.localHostId}.${target.deviceId}`
    : `ace.outbox.${target.url}.${target.deviceId}`;

/** A directory URL as the socket address a machine worker dials (and keys its outbox by). */
export function machineSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString();
}
