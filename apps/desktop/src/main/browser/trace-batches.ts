import { z } from "zod";

const Batch = z.object({ value: z.array(z.unknown()), aceTruncated: z.boolean().optional() });
const budget = 256 * 1024;

/** Leave room for the relay and tab envelopes, and explicitly report discarded events. */
export function* traceBatches(raw: unknown): Generator<{ value: unknown[]; aceTruncated?: true }> {
  const batch = Batch.safeParse(raw);
  if (!batch.success) return;
  let value: unknown[] = [];
  let bytes = 0;
  let truncated = batch.data.aceTruncated ?? false;
  for (const event of batch.data.value) {
    const serialized = JSON.stringify(event);
    const size = serialized === undefined ? 0 : Buffer.byteLength(serialized);
    if (size > budget) {
      truncated = true;
      continue;
    }
    if (bytes + size > budget || value.length >= 1000) {
      yield { value, ...(truncated ? { aceTruncated: true } : {}) };
      value = [];
      bytes = 0;
      truncated = false;
    }
    value.push(event);
    bytes += size;
  }
  if (value.length || truncated) yield { value, ...(truncated ? { aceTruncated: true } : {}) };
}
