import type { SuitDetail } from "@ace/protocol/suits";
import { ArrowUpIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn.ts";
import type { Scheme, ThemeId } from "@ace/themes";
import { suitDeclarations, suitFontFaces, suitSchemeFor } from "@/theme/suits/suit-css.ts";

/*
 * The ace window in miniature, for the mode and look pickers. A theme's tokens are scoped to it
 * the way `<html>` scopes them for the app (`data-theme` + `data-scheme`); a Suit's resolved
 * tokens (palette, radius, border weight, fonts) go on it inline, over its base theme, so a
 * theme and a Suit draw the same sketch. A Suit's backdrop sits behind it: the still its
 * manifest names for the scheme (`thumbnail`), else a soft gradient from its palette, with the
 * sidebar and main area translucent over it. Drawn in `em` off a font size in container units,
 * so it keeps its proportions at any size. Its edge answers the picker's hover through the
 * `group`, and gives way to the accent ring when chosen.
 */

/** A built-in theme, or a Suit as read from the library. */
export type PreviewLook = { theme: ThemeId } | { suit: SuitDetail };

/** What a theme's sketch resets, so a Suit on the page never reaches it through inheritance. */
const themeShape = { "--radius-scale": "1", "--border-weight": "1px" } as CSSProperties;

/** The radius of a sketch's part, scaled by the look's `--radius-scale`. */
const round = (em: number) => `calc(${em}em * var(--radius-scale, 1))`;

/** The backdrop behind a Suit's sketch in `scheme`: its still, else its palette's gradient. */
export function suitBackdrop(detail: SuitDetail, scheme: Scheme): string {
  const path = detail.manifest.thumbnail?.[suitSchemeFor(detail.manifest, scheme)];
  const url = path ? detail.assets[path] : undefined;
  if (url) return `center / cover no-repeat url(${JSON.stringify(url)})`;
  return [
    "radial-gradient(circle at 78% 18%, color-mix(in oklab, var(--ring) 34%, transparent), transparent 58%)",
    "radial-gradient(circle at 12% 88%, color-mix(in oklab, var(--ring) 18%, transparent), transparent 52%)",
    "linear-gradient(170deg, var(--surface-2), var(--sidebar))",
  ].join(", ");
}

function Line(props: { className: string }) {
  return <i className={cn("block h-[0.32em] shrink-0 rounded-full", props.className)} />;
}

/** How one scheme of the window is scoped: a theme by attribute, a Suit inline. */
function scope(look: PreviewLook, scheme: Scheme) {
  if ("theme" in look) return { theme: look.theme, scheme, style: themeShape };
  const { manifest } = look.suit;
  const drawn = suitSchemeFor(manifest, scheme);
  return {
    theme: manifest.base,
    scheme: drawn,
    style: suitDeclarations(look.suit, drawn) as CSSProperties,
    backdrop: suitBackdrop(look.suit, drawn),
  };
}

/** One scheme of the window: a quiet sidebar, one exchange and the composer. */
function Layer(props: { look: PreviewLook; scheme: Scheme; className?: string }) {
  const scoped = scope(props.look, props.scheme);
  const over = scoped.backdrop !== undefined;
  const hairline = { borderWidth: "var(--border-weight, 1px)" };
  return (
    <span
      data-theme={scoped.theme}
      data-scheme={scoped.scheme}
      data-look-backdrop={over ? "" : undefined}
      style={scoped.style}
      className={cn(
        "absolute inset-0 grid grid-cols-[28%_1fr] font-sans text-foreground",
        over ? "bg-sidebar" : "bg-background",
        props.className,
      )}
    >
      {over && (
        <span aria-hidden className="absolute inset-0" style={{ background: scoped.backdrop }} />
      )}
      <span
        style={{ borderRightWidth: "var(--border-weight, 1px)" }}
        className={cn(
          "relative flex min-w-0 flex-col gap-[0.35em] border-r border-border px-[0.45em] py-[0.8em]",
          over ? "bg-[color-mix(in_oklab,var(--sidebar)_72%,transparent)]" : "bg-sidebar",
        )}
      >
        <span
          style={{ borderRadius: round(0.4) }}
          className="flex items-center gap-[0.45em] bg-active px-[0.45em] py-[0.5em]"
        >
          <i className="size-[0.5em] shrink-0 rounded-full bg-status-working" />
          <Line className="w-3/4 bg-foreground/70" />
        </span>
        <span className="flex items-center gap-[0.45em] px-[0.45em] py-[0.5em]">
          <i className="size-[0.5em] shrink-0 rounded-full bg-status-needs-you" />
          <Line className="w-1/2 bg-subtle-foreground/60" />
        </span>
        <span className="flex items-center gap-[0.45em] px-[0.45em] py-[0.5em]">
          <i className="size-[0.5em] shrink-0 rounded-full bg-status-done" />
          <Line className="w-3/5 bg-subtle-foreground/60" />
        </span>
      </span>
      <span
        className={cn(
          "relative flex min-w-0 flex-col gap-[0.7em] px-[1.2em] pt-[1em] pb-[0.9em]",
          over && "bg-[color-mix(in_oklab,var(--background)_58%,transparent)]",
        )}
      >
        <i
          style={{ borderRadius: round(0.7) }}
          className="ml-auto block h-[1.4em] w-2/5 shrink-0 bg-bubble"
        />
        <span className="font-prose leading-none">Ready.</span>
        <Line className="w-4/5 bg-foreground/55" />
        <span className="flex items-center gap-[0.5em]">
          <Line className="w-1/4 bg-tint" />
          <Line className="w-2/5 bg-muted-foreground/45" />
        </span>
        <span
          style={{ ...hairline, borderRadius: round(0.9) }}
          className="mt-auto flex items-center gap-[0.5em] border-border-strong bg-popover py-[0.3em] pr-[0.3em] pl-[0.9em]"
        >
          <Line className="flex-1 bg-subtle-foreground/40" />
          <span className="grid size-[1.5em] shrink-0 place-items-center rounded-full bg-tint text-tint-foreground">
            <ArrowUpIcon weight="bold" className="size-[0.8em]" />
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * `look` as the app draws it in one scheme, or as one window split on a diagonal with the light
 * half on the left and the dark half on the right. A one-scheme Suit draws its own scheme in
 * both. Fills its parent, which sets the aspect.
 */
export function AppPreview(props: {
  look: PreviewLook;
  scheme: Scheme | "split";
  className?: string;
}) {
  const { look } = props;
  return (
    <span
      aria-hidden
      data-look-preview={"theme" in look ? look.theme : look.suit.manifest.id}
      className={cn(
        "relative block overflow-hidden rounded-lg border border-border transition-[border-color] duration-(--motion-base) group-hover:border-border-strong group-aria-checked:border-transparent [container-type:size]",
        props.className,
      )}
    >
      {/* A Suit's bundled faces, declared on the page: its tokens name them. */}
      {"suit" in look && <style>{suitFontFaces(look.suit).join("\n")}</style>}
      <span className="absolute inset-0 text-[length:min(4.4cqw,6.8cqh)]">
        <Layer look={look} scheme={props.scheme === "dark" ? "dark" : "light"} />
        {props.scheme === "split" && (
          <Layer
            look={look}
            scheme="dark"
            className="[clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]"
          />
        )}
      </span>
    </span>
  );
}
