import { ArrowUpIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { Scheme, ThemeId } from "@/theme/palettes.ts";

/*
 * The ace window in miniature, for the mode and theme pickers. Its tokens are scoped to it the way
 * `<html>` scopes them for the app (`data-theme` + `data-scheme`), so it shows the theme's real
 * surfaces, borders, type and accent. Each window is its own size container and is drawn in `em`
 * off a font size in container units, so it keeps its proportions at any card width.
 */

type Split = Scheme | "split";

function Thread(props: { status: string; width: string; selected?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-[0.4em] rounded-[0.35em] px-[0.4em] py-[0.4em]",
        props.selected && "bg-active",
      )}
    >
      <i className={cn("size-[0.45em] shrink-0 rounded-full", props.status)} />
      <i
        className={cn(
          "h-[0.3em] rounded-full",
          props.width,
          props.selected ? "bg-foreground/75" : "bg-subtle-foreground/55",
        )}
      />
    </span>
  );
}

/** One scheme of the window: a sidebar of threads, a short exchange and the composer. */
function Window(props: { theme: ThemeId; scheme: Scheme }) {
  return (
    <span
      data-theme={props.theme}
      data-scheme={props.scheme}
      className="relative min-w-0 flex-1 [container-type:size] overflow-hidden rounded-sm border border-border bg-background shadow-[0_4px_14px_-6px_rgb(0_0_0/0.35)]"
    >
      <span className="absolute inset-0 grid grid-cols-[32%_1fr] text-[length:min(8cqw,6.5cqh)] leading-[1.25] text-foreground">
        <span className="flex min-w-0 flex-col gap-[0.1em] border-r border-border bg-sidebar px-[0.3em] py-[0.6em]">
          <i className="mx-[0.4em] mb-[0.5em] h-[0.35em] w-1/2 rounded-full bg-foreground/70" />
          <Thread status="bg-status-working" width="w-4/5" selected />
          <Thread status="bg-status-needs-you" width="w-3/5" />
          <Thread status="bg-status-done" width="w-2/3" />
        </span>
        <span className="flex min-w-0 flex-col gap-[0.5em] px-[0.7em] pt-[0.7em] pb-[0.6em]">
          <i className="ml-auto h-[1.2em] w-1/2 shrink-0 rounded-[0.6em] bg-bubble" />
          <span className="truncate font-prose">Tests pass.</span>
          <i className="h-[0.3em] w-4/5 shrink-0 rounded-full bg-foreground/60" />
          <i className="h-[0.3em] w-1/2 shrink-0 rounded-full bg-muted-foreground/50" />
          <i className="mt-[0.3em] ml-auto h-[1.2em] w-2/5 shrink-0 rounded-[0.6em] bg-bubble" />
          <i className="h-[0.3em] w-3/4 shrink-0 rounded-full bg-foreground/60" />
          <i className="h-[0.3em] w-3/5 shrink-0 rounded-full bg-foreground/60" />
          <span className="mt-auto flex items-center gap-[0.4em] rounded-full border border-border-strong bg-popover py-[0.25em] pr-[0.25em] pl-[0.7em]">
            <i className="h-[0.3em] flex-1 rounded-full bg-subtle-foreground/45" />
            <span className="grid size-[1.3em] shrink-0 place-items-center rounded-full bg-tint text-tint-foreground">
              <ArrowUpIcon weight="bold" className="size-[0.75em]" />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * `theme` as the app draws it: one window in one scheme, or its light and dark windows side by
 * side. The band along the top stays clear for the picker's check. Fills its parent, which sets
 * the aspect.
 */
export function AppPreview(props: { theme: ThemeId; scheme: Split; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative block overflow-hidden rounded-sm bg-fill", props.className)}
    >
      <span className="absolute inset-x-[6%] top-[16%] bottom-[8%] flex gap-[5%]">
        {props.scheme === "split" ? (
          <>
            <Window theme={props.theme} scheme="light" />
            <Window theme={props.theme} scheme="dark" />
          </>
        ) : (
          <Window theme={props.theme} scheme={props.scheme} />
        )}
      </span>
    </span>
  );
}
