import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
// The build keeps only these weights in each icon (icon-weights.ts); others would draw nothing.
import type { UsedIconWeight } from "../../icon-weights.ts";

export type IconGlyph = PhosphorIcon;

/**
 * Phosphor icons with the design's weight rules: regular when inactive, fill when active or
 * selected, duotone for empty states. Icons are decorative unless given a `label`.
 */
export function Icon(props: {
  icon: IconGlyph;
  /** 14 dense rows · 16 default · 18 rail · 36/40 empty states. */
  size?: 12 | 13 | 14 | 16 | 18 | 20 | 36 | 40;
  active?: boolean | undefined;
  empty?: boolean | undefined;
  weight?: UsedIconWeight | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const Glyph = props.icon;
  const weight = props.weight ?? (props.empty ? "duotone" : props.active ? "fill" : "regular");
  return (
    <Glyph
      size={props.size ?? 16}
      weight={weight}
      className={cn("shrink-0", props.className)}
      {...(props.label ? { "aria-label": props.label, role: "img" } : { "aria-hidden": true })}
    />
  );
}
