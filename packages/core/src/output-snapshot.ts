import type { OutputSummary } from "@ace/protocol";
/** Snapshots can append only when their observed prefix agrees with the bounded stream tail. */
export function extendsOutput(prior: OutputSummary | undefined, aggregate: string): boolean {
  const bytes = new TextEncoder().encode(aggregate);
  const size = prior?.bytes ?? 0;
  const tail = prior?.tail ?? "";
  const tailSize = new TextEncoder().encode(tail).length;
  return (
    bytes.length >= size && new TextDecoder().decode(bytes.subarray(size - tailSize, size)) === tail
  );
}
