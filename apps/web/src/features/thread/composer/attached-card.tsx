import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { attachedSurface } from "./composer-styles.ts";

/** Cards waiting behind the top one, drawn as slivers above it; more read as the last. */
const slivers = ["inset-x-3 -top-2 opacity-90", "inset-x-6 -top-4 opacity-60"];

/**
 * A card attached to the composer: above it, a little narrower, its bottom tucked behind the
 * composer's top edge, one step quieter than the composer. It rises from behind the composer
 * when it arrives, and its contents settle in when the card on top changes (`cardKey`).
 * `behind` cards wait under it as slivers peeking out above, like a deck.
 */
export function AttachedCard(props: {
  /** The region's name for assistive tech: "Waiting for you", "Where this thread runs". */
  label: string;
  /** How many more cards wait under this one. */
  behind?: number | undefined;
  cardKey: string;
  onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
  children: ReactNode;
}) {
  const behind = Math.min(props.behind ?? 0, slivers.length);
  return (
    <div className="relative z-0 mx-3 -mb-4">
      {slivers.slice(0, behind).map((place, index) => (
        <div
          key={place}
          aria-hidden
          className={cn(
            "fx-fade-in absolute h-8 rounded-t-xl",
            attachedSurface,
            place,
            index === 0 ? "z-[-1]" : "z-[-2]",
          )}
        />
      ))}
      <section
        aria-label={props.label}
        // Before anything inside (a tooltip closing on Escape) can keep the key to itself.
        onKeyDownCapture={props.onKeyDown}
        className={cn(
          "fx-attach-in relative max-h-[min(56vh,560px)] overflow-y-auto overscroll-contain pb-7",
          attachedSurface,
        )}
      >
        {/* A new card on top settles in place; the surface stays. */}
        <div key={props.cardKey} className="fx-rise-in">
          {props.children}
        </div>
      </section>
    </div>
  );
}
