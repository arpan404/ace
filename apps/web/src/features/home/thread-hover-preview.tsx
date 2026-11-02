import type { ReactElement } from "react";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { ThreadHoverContent, useThreadHover } from "./thread-hover-card.tsx";
import { useThreadCard } from "./use-thread-card.ts";

/**
 * The Threads panel's details card for `threadId`, on any trigger (`children`, one element): a
 * delegated agent's row in a transcript opens what its sidebar row would. Opens once the pointer
 * settles and closes as soon as it leaves, as the panel's rows do. It opens under the trigger
 * (above it when there's no room), never over the panels beside it. A thread the list doesn't
 * hold yet shows the trigger alone.
 */
export function ThreadHoverPreview(props: { threadId: string; children: ReactElement }) {
  const data = useThreadCard(props.threadId, false);
  const hover = useThreadHover();
  if (!data) return props.children;
  const { entry, card } = data;
  const instance =
    (entry.switch?.state === "queued" ? entry.switch.selection.instanceId : undefined) ??
    entry.live?.account ??
    entry.execution?.instanceId;
  return (
    <HoverCard open={hover.open} onOpenChange={hover.change}>
      <HoverCardTrigger
        delay={450}
        closeDelay={0}
        onClick={() => hover.change(false)}
        render={props.children}
      />
      {hover.open && (
        <ThreadHoverContent card={card} entry={entry} instance={instance} placement="below" />
      )}
    </HoverCard>
  );
}
