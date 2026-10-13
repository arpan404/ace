import type { ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import { listTreeFacts, pluralCount, treeInBackground, treeWorking } from "@ace/ui-core";

/**
 * What still goes on in a listed thread's agent tree, in words for a question asked before
 * archiving it, or undefined when nothing does. Waiting on the person counts, and so do
 * background commands left after the turn: not Working, but archiving would hide them. Pure.
 */
export function runningWork(thread: {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
}): string | undefined {
  const facts = listTreeFacts(thread);
  if (facts.needsYou) return "It's waiting for you.";
  if (!treeWorking(facts) && !treeInBackground(facts)) return undefined;
  const parts = [
    facts.root === "working" ? "the agent" : undefined,
    facts.subagents ? pluralCount(facts.subagents, "subagent", "subagents") : undefined,
    facts.backgroundCommands
      ? pluralCount(facts.backgroundCommands, "background command", "background commands")
      : undefined,
  ].filter((part) => part !== undefined);
  if (!parts.length) return "Its agent is still working.";
  const last = parts.pop();
  return `Still running: ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}
