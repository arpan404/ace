import type { Frame } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";

const directions = new Set<unknown>(["send", "recv", "stderr", "note"]);
const billingModes = new Set<unknown>(["api", "subscription", "unknown"]);

/**
 * Why an adapter's frame envelope is malformed, or undefined when it is sound. ace's own session
 * built it (ADR 0125), so it is checked in place, never parsed into a copy; a bad envelope is an
 * adapter bug that must still fail the session visibly.
 */
export function frameEnvelopeError(frame: Frame): string | undefined {
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) return "seq";
  if (typeof frame.t !== "number" || !Number.isFinite(frame.t) || frame.t < 0) return "t";
  if (!directions.has(frame.dir)) return "dir";
  if (typeof frame.channel !== "string") return "channel";
  if (frame.payload !== undefined && !ProviderPayload.is(frame.payload)) return "payload";
  const account = frame.usageAccount;
  if (account !== undefined) {
    if (typeof account !== "object" || account === null) return "usageAccount";
    if (typeof account.id !== "string" || account.id.length < 1 || account.id.length > 512)
      return "usageAccount.id";
    if (!billingModes.has(account.billingMode)) return "usageAccount.billingMode";
  }
  return undefined;
}
