import { useEffect, type ReactElement } from "react";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { useOpenGate } from "@/components/ui/open-gate.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { deferredPart, usePart } from "@/lib/deferred-part.ts";
import type { AgentRowParts } from "./agent-row.tsx";

// The card's popup and body, out of the thread's first paint: loaded once the browser is idle,
// or when a card first asks to open, and the card opens once they are in, whole.
// Pure: a call the bundler must keep would hold the loader in every chunk importing this.
const Popup = /* @__PURE__ */ deferredComponent(() =>
  import("./agent-hover-popup.tsx").then((module) => module.AgentHoverPopup),
);
const popup = /* @__PURE__ */ deferredPart(Popup.preload);

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
  useEffect(() => popup.warm(), []);
  const gate = useOpenGate(popup, {});
  const ready = usePart(popup) !== undefined;
  return (
    <HoverCard open={gate.open} onOpenChange={gate.onOpenChange}>
      <HoverCardTrigger delay={450} closeDelay={0} render={props.children} />
      {/* Mounted once the code is in, so it renders at once, never suspending in an open card. */}
      {ready && (
        <LocalBoundary label="the agent's details" fallback={null}>
          <Popup.Component parts={props.parts} />
        </LocalBoundary>
      )}
    </HoverCard>
  );
}
