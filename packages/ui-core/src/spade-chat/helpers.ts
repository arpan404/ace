import { z } from "zod";
import { emptySpadeConversation, foldSpade } from "./fold.ts";
import type { SpadeStored } from "./wire.ts";
import { spadeCallLine } from "./words.ts";

/*
 * Helpers (ADR 0152): a bot hands part of its work to a short-lived helper, which runs as one of
 * its background jobs in a hidden conversation of its own. In the bot's conversation each helper
 * is one line in Spade's words, which expands to the helper's own steps.
 */

/** One of a helper's steps, as its expanded line shows it. */
export interface SpadeHelperStep {
  key: string;
  kind: "text" | "call";
  text: string;
}

/**
 * A helper's steps from its own conversation's stored events: its words, and a line per call in
 * the same words a bot's calls read in. Its task, the first message, is the line itself.
 */
export function spadeHelperSteps(events: readonly SpadeStored[]): SpadeHelperStep[] {
  const state = emptySpadeConversation();
  for (const stored of events) foldSpade(state, { kind: "stored", stored });
  const steps: SpadeHelperStep[] = [];
  for (const entry of state.entries) {
    if (entry.kind !== "reply") continue;
    for (const part of entry.parts) {
      if (part.kind === "text" && part.text.trim())
        steps.push({ key: `${entry.key}:${part.key}`, kind: "text", text: part.text.trim() });
      if (part.kind === "call")
        steps.push({
          key: `${entry.key}:${part.key}`,
          kind: "call",
          text: spadeCallLine(part.name, part.state),
        });
    }
    if (entry.live.trim())
      steps.push({ key: `${entry.key}:live`, kind: "text", text: entry.live.trim() });
    if (entry.end?.kind === "failed")
      steps.push({ key: `${entry.key}:end`, kind: "text", text: `Stopped: ${entry.end.error}` });
  }
  return steps;
}

const helperRow = z.looseObject({
  job: z.string(),
  conversation: z.string(),
  profile: z.string().catch(""),
  task: z.string().nullish().catch(undefined),
  state: z.string().catch(""),
  cost_micros: z.number().nonnegative().catch(0).default(0),
});

export type SpadeHelperRow = z.infer<typeof helperRow>;

/** `GET /v1/conversations/{id}/helpers`; undefined when the body doesn't fit. */
export function parseSpadeHelpers(body: string): SpadeHelperRow[] | undefined {
  try {
    const parsed = z.object({ helpers: z.array(helperRow) }).safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.helpers : undefined;
  } catch {
    return undefined;
  }
}
