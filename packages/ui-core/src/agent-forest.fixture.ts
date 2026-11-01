import { Agent, type AgentStatus } from "@ace/protocol";
import type { ThreadWork } from "./agent-forest.ts";

const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "tool" };

/**
 * A fixed chain of `threads` threads, each delegating to the next, whose main agents each have
 * `width` subagents (every other one working). Only the width varies between sizes, so a join's
 * cost per sibling shows directly. Rows the join places: `threads * width`, besides the main row.
 */
export function wideForest(threads: number, width: number): Map<string, ThreadWork> {
  let clock = 0;
  const works = new Map<string, ThreadWork>();
  for (let level = 0; level < threads; level++) {
    const threadId = `w${level}`;
    const make = (id: string, status: AgentStatus, parentId: string | null, child?: string) =>
      Agent.parse({
        id,
        parentId,
        threadId,
        childThreadId: child,
        origin: parentId ? "ace" : "root",
        native: { provider: "claude", nativeId: `${threadId}-${id}` },
        fidelity: "full",
        cwd: "/project",
        status,
        createdAt: clock++,
      });
    const agents = [make("root", idle, null)];
    for (let index = 0; index < width; index++) {
      const child = index === 0 && level + 1 < threads ? `w${level + 1}` : undefined;
      agents.push(make(`a${index}`, index % 2 ? working : idle, "root", child));
    }
    works.set(threadId, { agents, tasks: [], interactions: [] });
  }
  return works;
}
