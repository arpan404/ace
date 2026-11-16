import type { AgentStatus } from "@ace/protocol";
import { agentStatusLabel, type Tone } from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";

/*
 * The words and tone a device tile derives from the state of the agent driving it. Takes `live`
 * first, required, and returns the stale words before reading any state while the agent's
 * thread copy isn't current: who holds the device is the device's own fact, what its agent is
 * doing is not. The `ace/live-actions` lint rule keeps `agentStatusLabel` to files named
 * live-words.ts.
 */

/** Short words for what keeps a driving agent from acting, by its status tone. */
const driverWords: Partial<Record<Tone, string>> = {
  working: "driving",
  waiting: "waiting",
  "needs-you": "needs you",
  failed: "failed",
};

/**
 * A driving agent's status as a tone and a word: "driving" while it works, otherwise what keeps
 * it from acting; with no agent row here (another machine's), working. The stale words, idle,
 * while not current.
 */
export function driverStatus(
  live: Live,
  status: AgentStatus | undefined,
): { label: string; tone: Tone; word: string } {
  if (!live.current) return { label: live.word, tone: "idle", word: live.word };
  const { label, tone } = status
    ? agentStatusLabel(status)
    : { label: "Working", tone: "working" as const };
  return { label, tone, word: driverWords[tone] ?? "idle" };
}
