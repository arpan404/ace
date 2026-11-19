import type { SuitOrnamentSlot } from "@ace/protocol/suit-parts";
import { cn } from "@/lib/cn.ts";
import { useSuitOnScreen } from "../theme-provider.tsx";

/**
 * A Suit's ornament in its slot (ADR 0150, "Ornaments"): static markup the daemon rebuilt from
 * an allowlist (`sanitiseOrnament` in @ace/suits), so no script, handler or outside reference
 * survives to here. It is decoration only: hidden from assistive tech, inert, never hit by the
 * pointer, and contained, so nothing in it can paint outside its box or over a protected part.
 * Slots sit in the flow (or, for the window's corners, under every surface), never on top of
 * the approval strip, the Working line or a status mark. Nothing renders without one.
 */
export function SuitOrnament(props: { slot: SuitOrnamentSlot; className?: string | undefined }) {
  const markup = useSuitOnScreen()?.ornaments[props.slot];
  if (!markup) return null;
  return (
    <div
      aria-hidden
      inert
      data-ornament={props.slot}
      className={cn(
        "pointer-events-none shrink-0 overflow-hidden select-none [contain:layout_paint_style] [&_svg]:max-h-full [&_svg]:max-w-full [&_img]:max-h-full [&_img]:max-w-full",
        props.className,
      )}
      // Sanitised by the daemon, which this build trusts (ADR 0125); see the comment above.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** The window's four corners, under every surface: they show where the frame colour does. */
export function SuitCornerOrnaments() {
  return (
    <>
      <SuitOrnament slot="corner-top-left" className="absolute top-0 left-0 -z-[5] size-40" />
      <SuitOrnament slot="corner-top-right" className="absolute top-0 right-0 -z-[5] size-40" />
      <SuitOrnament slot="corner-bottom-left" className="absolute bottom-0 left-0 -z-[5] size-40" />
      <SuitOrnament
        slot="corner-bottom-right"
        className="absolute right-0 bottom-0 -z-[5] size-40"
      />
    </>
  );
}
