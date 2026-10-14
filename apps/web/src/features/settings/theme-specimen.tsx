import { themes, type ThemeId } from "@/theme/palettes.ts";

const dots = [
  "bg-status-working",
  "bg-status-needs-you",
  "bg-status-done",
  "bg-status-failed",
] as const;

/**
 * One scheme of the specimen: the scheme's own ink ("Aa" in the theme's interface face), its
 * accent as a bar, and its status hues as dots. Colours come from the theme's own tokens
 * (`data-theme` + `data-scheme` scope them the way `<html>` scopes them for the app), so the
 * specimen is truthful. Decorative: the card's name stays the accessible label.
 */
function Half(props: { theme: ThemeId; scheme: "light" | "dark" }) {
  return (
    <span
      data-theme={props.theme}
      data-scheme={props.scheme}
      aria-hidden
      className="flex min-w-0 flex-col items-start gap-1.5 bg-(--background) px-3 py-3"
    >
      <span aria-hidden className="text-xl font-semibold text-foreground">
        Aa
      </span>
      <span aria-hidden className="h-1 w-10 rounded-full bg-tint" />
      <span aria-hidden className="flex items-center gap-1">
        {dots.map((dot) => (
          <span key={dot} aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        ))}
      </span>
    </span>
  );
}

/**
 * A theme as a material specimen: its light and dark schemes side by side, each showing ink,
 * accent and status hues. It reads like a swatch card rather than a screenshot, which keeps it
 * distinct from the mode cards' live window previews. Decorative; the name stays the label.
 */
export function ThemeSpecimen(props: { id: ThemeId }) {
  return (
    <span
      aria-hidden
      style={{ fontFamily: themes[props.id].fonts.ui }}
      className="grid grid-cols-2 overflow-hidden rounded-md border border-border transition-colors duration-(--motion-base) group-hover:border-border-strong"
    >
      <Half theme={props.id} scheme="light" />
      <Half theme={props.id} scheme="dark" />
    </span>
  );
}
