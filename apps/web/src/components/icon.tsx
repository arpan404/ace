import type { Icon as AceIcon, IconWeight } from "@ace/icons";
import { cn } from "@/lib/cn.ts";

export type IconGlyph = AceIcon;

/** The weights the design draws in: regular at rest, fill when active or a status, bold for a few small glyphs. */
export type UsedIconWeight = Extract<IconWeight, "regular" | "fill" | "bold">;
/** The weights a glyph table may pin: the used ones, and two-tone for empty states. */
export type TableWeight = UsedIconWeight | "duotone";

/**
 * An icon with the design's weight rules: regular when inactive, fill when active or selected;
 * an empty state's two-tone glyph comes from `empty-glyphs.ts`. Icons are decorative unless
 * given a `label`.
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
 * the first. A table pins its look (file-type marks regular, empty states two-tone) whatever a
 * caller asks for.
 */
export function pinnedGlyph(Glyph: IconGlyph, weights: readonly TableWeight[]): IconGlyph {
  const [first = "regular"] = weights;
  const Pinned: IconGlyph = (props) => {
    const weight = weights.find((kept) => kept === props.weight) ?? first;
    return <Glyph {...props} weight={weight} />;
  };
  Pinned.displayName = Glyph.displayName ?? "Glyph";
  return Pinned;
}
