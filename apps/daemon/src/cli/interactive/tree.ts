import type { ThreadReader } from "@ace/client";
import {
  agentName,
  describeActivity,
  formatElapsed,
  glyphOf,
  type AgentGlyph,
  type RowStatusTone,
} from "@ace/ui-core";

/**
 * A thread's agent tree under its home row (ADR 0108, ADR 0176 §9): each agent, what it does,
 * its time. Pure over the client's thread store; the root agent leads, its subagents follow
 * in launch order, indented by depth.
 */
export interface TreeLine {
  readonly depth: number;
  readonly glyph: string;
  readonly tone: RowStatusTone;
  readonly name: string;
  readonly doing: string;
  readonly time: string;
}

const looks: Record<AgentGlyph, { glyph: string; tone: RowStatusTone }> = {
  spinner: { glyph: "◌", tone: "working" },
  waiting: { glyph: "◌", tone: "waiting" },
  "needs-you": { glyph: "◆", tone: "needs-you" },
  failed: { glyph: "✕", tone: "failed" },
  done: { glyph: "✓", tone: "idle" },
  stopped: { glyph: "■", tone: "idle" },
};

/** At most this many agents show under a row; the rest are counted. */
const shown = 12;

export function agentTree(
  reader: ThreadReader,
  now: number,
): { lines: TreeLine[]; more: number } {
  const root = reader.thread?.rootAgentId;
  if (!root) return { lines: [], more: 0 };
  const lines: TreeLine[] = [];
  let total = 0;
  const visit = (id: string, depth: number) => {
    const agent = reader.agent(id);
    if (!agent) return;
    total++;
    if (lines.length < shown) {
      const look = looks[glyphOf(agent.status)];
      const active = look.tone === "working" || look.tone === "waiting" || look.tone === "needs-you";
      lines.push({
        depth,
        glyph: look.glyph,
        tone: look.tone,
        name: agentName(agent),
        doing: describeActivity(agent.status),
        time: active ? formatElapsed(now - agent.createdAt) : "",
      });
    }
    if (depth < 6) for (const child of reader.children(id)) visit(child, depth + 1);
  };
  visit(root, 0);
  return { lines, more: Math.max(0, total - lines.length) };
}
