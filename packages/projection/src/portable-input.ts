import { withoutHandoffEnvelope } from "@ace/handoff";
import type { ContentPart } from "@ace/protocol";

/** Remove only ace's validated leading handoff block, including echoes joined into one text part. */
export function withoutPortableHandoff(parts: readonly ContentPart[]): ContentPart[] {
  const first = parts[0];
  if (first?.type !== "text") return [...parts];
  const rest = withoutHandoffEnvelope(first.text);
  if (rest === undefined) return [...parts];
  return [...(rest ? [{ type: "text" as const, text: rest }] : []), ...parts.slice(1)];
}
