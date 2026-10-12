import type { AgentStatus } from "@ace/protocol";
import { glyphOf, type AgentGlyph } from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";

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

/** An agent's status as one mark: spinner while it works, a dot when it needs you or failed. */
export function AgentStatusMark(props: {
  status: AgentStatus;
  pending?: boolean;
  needsYou?: boolean;
}) {
  switch (agentMark(props.status, props.pending, props.needsYou)) {
    case "spinner":
      return <LiveWorkMark className="text-status-working" />;
    case "waiting":
      return <LiveWorkMark className="text-status-waiting" />;
    case "needs-you":
      return <Dot tone="needs-you" className="mx-[2.5px]" />;
    case "failed":
      return <Dot tone="failed" className="mx-[2.5px]" />;
    case "stopped":
      return <Dot tone="idle" className="mx-[2.5px]" />;
    case "done":
      return <CheckIcon aria-hidden size={11} className="text-subtle-foreground" />;
  }
}
