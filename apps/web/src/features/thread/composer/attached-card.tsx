import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { attachedSurface } from "./composer-styles.ts";

/** Cards waiting behind the top one, drawn as slivers above it, farthest first. */
const slivers = ["inset-x-6 -top-4 opacity-60", "inset-x-3 -top-2 opacity-90"];

/**
 * The tab attached to the composer: above it, a little narrower, its bottom tucked behind the
 * composer's top edge so the composer overlaps it like the front card of a stack, one step
 * quieter than the composer itself. A `strip` is one line (where the thread runs, what the
 * agents are doing, the step of their plan); a card is raised (the whole plan, a question, the
 * environment's details) and scrolls past half the window. It rises from behind the composer
 * when it arrives, and its contents settle in when what it shows changes (`cardKey`). `behind`
 * cards wait under it as slivers peeking out above, like a deck.
 */
export function AttachedCard(props: {
  /** The region's name for assistive tech: "Waiting for you", "Where this thread runs". */
  label: string;
  /** One line rather than a raised card. */
  strip?: boolean | undefined;
  /** How many more cards wait under this one. */
  behind?: number | undefined;
  cardKey: string;
  onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
  children: ReactNode;
}) {
  const behind = Math.min(props.behind ?? 0, slivers.length);
  return (
    <div className="relative z-0 mx-4">
      {slivers.slice(slivers.length - behind).map((place) => (
        <div
          key={place}
          aria-hidden
          className={cn("fx-fade-in absolute -z-10 h-8", attachedSurface, place)}
        />
      ))}
      {/* It rises from behind the composer: a panel coming in from its bottom edge. */}
      <section
        data-edge="bottom"
        aria-label={props.label}
        // Before anything inside (a tooltip closing on Escape) can keep the key to itself.
        onKeyDownCapture={props.onKeyDown}
        className={cn(
          "fx-panel-in relative",
          props.strip ? "" : "max-h-[50vh] overflow-y-auto overscroll-contain pb-3",
          props.label === "Plan" ? "" : attachedSurface,
        )}
      >
        {/* What it shows changing settles in place; the surface stays. */}
        <div key={props.cardKey} className="fx-rise-in">
          {props.children}
        </div>
      </section>
    </div>
  );
}
