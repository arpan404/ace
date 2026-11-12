import { Suspense, useEffect, type ReactElement } from "react";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { AgentRowParts } from "./agent-row.tsx";

/**
 * The card's body, mounted only while it is open: its code loads once a row first shows, well
 * before the pointer has settled on one, off the thread route's first paint.
 */
const DeferredCardBody = deferredComponent(() =>
  import("./agent-hover-card-body.tsx").then((module) => module.CardBody),
);

/**
 * An agent row's hover card, the sidebar's in a transcript's shape: who the agent is and how it
 * stands, whole where the row cuts it. Its name with its status and time on the same line, then
 * the account, model and effort it runs on under its provider's mark, then the machine it runs
 * on, then, under a hairline, its latest turn as the row's second line says it, whole: what it
 * does now, what it found, what it waits on, or why it failed. The account is the one the row's
 * mark wears (`useAgentAccount`), named once its machine's accounts load. It opens under the
 * row (above when there's no room) once the pointer settles, and closes when it leaves.
 */
export function AgentHoverCard(props: {
  /** The row's own parts: name, status, time, mark, meta and machine. */
  parts: AgentRowParts;
  /** The row's link or button, one element. */
  children: ReactElement;
}) {
  useEffect(() => void DeferredCardBody.preload(), []);
  return (
    <HoverCard>
      <HoverCardTrigger delay={450} closeDelay={0} render={props.children} />
      <HoverCardContent
        side="bottom"
        sideOffset={4}
        align="start"
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        aria-label={`Details for ${props.parts.name}`}
        className="w-80 max-w-[calc(100vw-24px)] px-3 py-2.5"
      >
        <Suspense fallback={null}>
          <DeferredCardBody.Component parts={props.parts} />
        </Suspense>
      </HoverCardContent>
    </HoverCard>
  );
}
