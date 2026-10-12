import { maxProviderPayloadBytes } from "@ace/provider-kit/payload";
import type { ContentPart } from "@ace/protocol";
import { requireContext } from "./errors.ts";

// Reserve native IDs, RPC/diagnostic envelopes and injected guidance before embedding data.
export const maxEncodedContextBytes = maxProviderPayloadBytes - 64 * 1024;
export function encodedContextBudget(input: readonly ContentPart[]): number {
  // Paths can expand to percent-encoded native URIs. Text and framing use the same conservative allowance.
  const remaining = maxEncodedContextBytes - 3 * Buffer.byteLength(JSON.stringify(input));
  requireContext(remaining >= 0, "quota", "Prompt leaves no bounded space for attachment context");
  return remaining;
}

/** One linear pass counts JSON escaping, base64, combined attachments and fallback text. */
export function boundEncodedContext<T>(
  input: readonly T[],
  fallback: (index: number) => T,
  limit: number,
): T[] {
  let remaining = limit - 2;
  const fallbacks = input.map((_part, index) => fallback(index));
  const costs = fallbacks.map((part) => Buffer.byteLength(JSON.stringify(part)) + 1);
  let reserved = costs.reduce((sum, bytes) => sum + bytes, 0);
  requireContext(
    reserved <= remaining,
    "quota",
    "Attachment references exceed the encoded prompt budget",
  );
  return input.map((candidate, index) => {
    reserved -= costs[index] ?? 0;
    let part = candidate;
    let bytes = Buffer.byteLength(JSON.stringify(part)) + 1;
    if (bytes > remaining - reserved) {
      const replacement = fallbacks[index];
      requireContext(replacement !== undefined, "invalid_request", "Missing attachment fallback");
      part = replacement;
      bytes = Buffer.byteLength(JSON.stringify(part)) + 1;
    }
    requireContext(
      bytes <= remaining,
      "quota",
      "Attachment references exceed the encoded prompt budget",
    );
    remaining -= bytes;
    return part;
  });
}
