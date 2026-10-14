import type { AgentStatus } from "@ace/protocol";
import { glyphOf, type AgentGlyph } from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { agentGlyph } from "@/components/status-glyph-state.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";

/**
 * Which mark an agent's status draws: needing the person outranks everything, and an agent
 * whose own turn ended while its work still runs reads as waiting. The tree's mark and the
 * Summary tab's capsules share it.
 */
export function agentMark(status: AgentStatus, pending?: boolean, needsYou?: boolean): AgentGlyph {
  const glyph = glyphOf(status);
  if (needsYou) return "needs-you";
  return pending && (glyph === "done" || glyph === "stopped") ? "waiting" : glyph;
}

/**
 * An agent's status as one glyph (status-glyph.tsx), held still while the facts are stale: a
 * rocking ring while it works, ratcheting arcs while it waits on its own, a solid "!" when it
 * needs you, a cross when it failed.
 */
export function AgentStatusMark(props: {
  status: AgentStatus;
  pending?: boolean;
  needsYou?: boolean;
}) {
  const fresh = useLiveConnection().fresh;
  return (
    <StatusGlyph
      state={agentGlyph(agentMark(props.status, props.pending, props.needsYou))}
      size={12}
      still={!fresh}
    />
  );
}
