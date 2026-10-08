import type { AgentStatus } from "@ace/protocol";
import { glyphOf } from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";

/** An agent's status as one mark: spinner while it works, a dot when it needs you or failed. */
export function AgentStatusMark(props: { status: AgentStatus }) {
  switch (glyphOf(props.status)) {
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
