import { ArrowUpIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { Scheme, ThemeId } from "@/theme/palettes.ts";

/*
 * The ace window in miniature, for the mode and theme pickers. Its tokens are scoped to it the way
 * `<html>` scopes them for the app (`data-theme` + `data-scheme`), so it shows the theme's real
 * surfaces, borders, type and accent. It is drawn in `em` off a font size in container units, so
 * it keeps its proportions at any card size.
 */

function Line(props: { className: string }) {
  return <i className={cn("block h-[0.32em] shrink-0 rounded-full", props.className)} />;
}

/** One scheme of the window: a quiet sidebar, one exchange and the composer. */
function Layer(props: { theme: ThemeId; scheme: Scheme; className?: string }) {
  return (
    <span
      data-theme={props.theme}
      data-scheme={props.scheme}
      className={cn(
        "absolute inset-0 grid grid-cols-[28%_1fr] bg-background text-foreground",
        props.className,
      )}
    >
      <span className="flex min-w-0 flex-col gap-[0.75em] border-r border-border bg-sidebar px-[0.9em] py-[1em]">
        <span className="flex items-center gap-[0.45em]">
          <i className="size-[0.5em] shrink-0 rounded-full bg-status-working" />
          <Line className="w-3/4 bg-foreground/70" />
        </span>
        <Line className="ml-[0.95em] w-1/2 bg-subtle-foreground/50" />
        <Line className="ml-[0.95em] w-3/5 bg-subtle-foreground/50" />
      </span>
      <span className="flex min-w-0 flex-col gap-[0.7em] px-[1.2em] pt-[1em] pb-[0.9em]">
        <i className="ml-auto block h-[1.4em] w-2/5 shrink-0 rounded-full bg-bubble" />
        <span className="font-prose leading-none">Ready.</span>
        <Line className="w-4/5 bg-foreground/55" />
        <Line className="w-3/5 bg-muted-foreground/45" />
        <span className="mt-auto flex items-center gap-[0.5em] rounded-full border border-border-strong bg-popover py-[0.3em] pr-[0.3em] pl-[0.9em]">
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
 * `theme` as the app draws it in one scheme, or as one window split down the middle with the
 * light half on the left and the dark half on the right. Fills its parent, which sets the aspect.
 */
export function AppPreview(props: {
  theme: ThemeId;
  scheme: Scheme | "split";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block overflow-hidden rounded-sm border border-border [container-type:size]",
        props.className,
      )}
    >
      <span className="absolute inset-0 text-[length:min(4.4cqw,6.8cqh)]">
        <Layer theme={props.theme} scheme={props.scheme === "dark" ? "dark" : "light"} />
        {props.scheme === "split" && (
          <Layer theme={props.theme} scheme="dark" className="[clip-path:inset(0_0_0_50%)]" />
        )}
      </span>
    </span>
  );
}
