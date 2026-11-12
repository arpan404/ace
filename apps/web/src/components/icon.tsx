import type { IconProps, Icon as PhosphorIcon } from "@phosphor-icons/react";
import { forwardRef } from "react";
import { cn } from "@/lib/cn.ts";
// The build keeps only these weights in each icon (icon-weights.ts); others would draw nothing.
import type { TableWeight, UsedIconWeight } from "../../icon-weights.ts";

export type IconGlyph = PhosphorIcon;

/**
 * Phosphor icons with the design's weight rules: regular when inactive, fill when active or
 * selected; an empty state's duotone glyph comes from `empty-glyphs.ts`. Icons are decorative
 * unless given a `label`.
 */
export function Icon(props: {
  icon: IconGlyph;
  /** 14 dense rows · 16 default · 18 rail · 36/40 empty states. */
  size?: 12 | 13 | 14 | 16 | 18 | 20 | 36 | 40;
  active?: boolean | undefined;
  weight?: UsedIconWeight | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const Glyph = props.icon;
  const weight = props.weight ?? (props.active ? "fill" : "regular");
  return (
    <Glyph
      size={props.size ?? 16}
      weight={weight}
      className={cn("shrink-0", props.className)}
      {...(props.label ? { "aria-label": props.label, role: "img" } : { "aria-hidden": true })}
    />
  );
}

/**
 * A glyph table's icon, drawn only in `weights`: the asked weight when it is one of them, else
 * the first. The build keeps only these weights in an icon that glyph tables alone draw
 * (`glyphTables` in `icon-weights.ts`), so no caller can ask for one it dropped.
 */
export function pinnedGlyph(Glyph: IconGlyph, weights: readonly TableWeight[]): IconGlyph {
  const [first = "regular"] = weights;
  const Pinned = forwardRef<SVGSVGElement, IconProps>(function Pinned(props, ref) {
    const asked = props.weight;
    const weight = weights.find((kept) => kept === asked) ?? first;
    return <Glyph {...props} ref={ref} weight={weight} />;
  });
  Pinned.displayName = Glyph.displayName ?? "Glyph";
  return Pinned;
}
