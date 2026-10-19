import type { Tone } from "@ace/ui-core";

/*
 * Which linked task speaks for all of them in the PR header's agent chip. The loudest state
 * wins, so the chip never says "done" while any task still works, waits or needs the person.
 */

const rank: Record<Tone, number> = {
  "needs-you": 0,
  failed: 1,
  working: 2,
  waiting: 3,
  background: 4,
  idle: 5,
  done: 6,
};

export function presenceLead<T extends { tone: Tone }>(items: readonly T[]): T | undefined {
  return items.toSorted((a, b) => rank[a.tone] - rank[b.tone])[0];
}

/** "working 3m", "needs you", "done": the lead's status in the chip's words. */
export function presenceWords(status: { label: string; tone: Tone }, elapsed?: string): string {
  const word = status.label.toLowerCase();
  return status.tone === "working" && elapsed ? `${word} ${elapsed}` : word;
}
