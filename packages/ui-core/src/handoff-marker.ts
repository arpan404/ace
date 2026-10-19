import type { Item, ProviderKind } from "@ace/protocol";
import { withoutHandoffEnvelope } from "@ace/handoff";
import { modelLabel, providerNames } from "./providers.ts";
import { systemInput } from "./system-events.ts";

/*
 * The transcript marker for a context handoff: the thread moved to another provider and the new
 * agent took the conversation over from a quoted excerpt. Web and iOS draw the same divider
 * from this: "⇄ Context handoff  GPT-6.1-Sol, Muse Spark → Claude Opus 5.5". Pure.
 */

export interface HandoffEnd {
  provider: ProviderKind;
  model?: string | undefined;
  /** The model's display name, or the provider's when the model is unknown. */
  name: string;
}

export interface HandoffMarker {
  label: string;
  /** Every model whose work was carried over, oldest first; empty when none is known. */
  from: HandoffEnd[];
  to: HandoffEnd;
  /** The whole marker as one sentence, for assistive tech and plain-text rows. */
  text: string;
  /** The context the new agent received, readable: the excerpts without the preamble. */
  received: string;
}

export const handoffLabel = "Context handoff";

const end = (side: { provider: ProviderKind; model?: string | undefined }): HandoffEnd => ({
  provider: side.provider,
  ...(side.model ? { model: side.model } : {}),
  name: side.model ? modelLabel(side.model) : providerNames[side.provider],
});

/** The handoff `item` marks, or undefined for anything else (and handoffs without a target). */
export function handoffMarker(item: Item | undefined): HandoffMarker | undefined {
  const input = systemInput(item);
  const origin = input?.kind === "handoff" ? input.origin : undefined;
  if (!input || !origin?.to) return undefined;
  const sources = origin.sources?.length ? origin.sources : origin.from ? [origin.from] : [];
  const from = sources.map(end);
  const to = end(origin.to);
  const names = from.map((side) => side.name).join(", ");
  return {
    label: handoffLabel,
    from,
    to,
    text: names ? `${handoffLabel}: ${names} → ${to.name}` : `${handoffLabel} to ${to.name}`,
    received: receivedExcerpts(input.text),
  };
}

/** The excerpts of a rendered handoff, without ace's framing; other text as it is. */
function receivedExcerpts(text: string): string {
  if (withoutHandoffEnvelope(text) === undefined) return text;
  const start = text.indexOf("\n--- item ");
  const close = text.lastIndexOf("\n</");
  if (start < 0) return "No earlier messages fit; the agent can read the thread's history.";
  return text
    .slice(start + 1, close > start ? close : undefined)
    .replace(/^--- item [^\n]*\n/gm, "")
    .trim();
}
