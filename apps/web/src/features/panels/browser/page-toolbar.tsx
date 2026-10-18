import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { TooltipSide } from "@/components/ui/tooltip.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";

/** A round control inside a pill: 28px in the pill's 32px, so the corners stay concentric. */
const tool = "size-7 rounded-full";
/** What a toolbar narrower than 28rem leaves out so the address keeps its room. */
export const narrowHidden = "@max-[28rem]:hidden";
/** Navigation, the address taking the room that is left, the tab's actions. */
const columns = { gridTemplateColumns: "auto minmax(0, 1fr) auto" };
/** Controls grouped on one quiet capsule, as one object. */
export const toolPill = "flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-foreground/5 p-0.5";

/** One navigation control: available with `onClick` unless `disabled`. */
export interface NavControl {
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  keys?: string | undefined;
}

/** Controls grouped on one pill (Extensions and Downloads, say). */
export function ToolPill(props: { children: ReactNode; className?: string }) {
  return <div className={cn(toolPill, props.className)}>{props.children}</div>;
}

/**
 * Back and Forward, then Reload (Stop while loading) past a hairline, on one pill. Every
 * page-like tab draws the same pill, so the toolbar never changes shape between a new tab, a
 * page and a preview. `after` sits beside it on its own (Annotate).
 */
export function PageNav(props: {
  back: NavControl;
  forward: NavControl;
  reload: NavControl;
  stop?: NavControl;
  loading?: boolean;
  /** A page tool drawn beside the pill (Annotate). */
  after?: ReactNode;
}) {
  const control = (
    name: string,
    icon: typeof ArrowLeftIcon,
    value: NavControl,
    className?: string,
  ) => (
    <IconButton
      icon={icon}
      label={name}
      {...(value.keys ? { keys: value.keys } : {})}
      disabled={!value.onClick || !!value.disabled}
      focusableWhenDisabled
      className={className ? `${tool} ${className}` : tool}
      onClick={value.onClick}
    />
  );
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div className={toolPill}>
        {control("Back", ArrowLeftIcon, props.back)}
        {/* A narrow toolbar keeps the address's room: Forward stays on ⌘]. */}
        {control("Forward", ArrowRightIcon, props.forward, narrowHidden)}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        {props.loading
          ? control("Stop", XIcon, props.stop ?? {})
          : control("Reload", ArrowClockwiseIcon, props.reload)}
      </div>
      {props.after}
    </div>
  );
}

/**
 * The toolbar over every page-like tab (a new tab, a browser page, a preview, a port): the
 * navigation pill on the left, the address pill in the room between, the tab's own pills on
 * the right, and a thin progress bar along the bottom edge while the page loads.
 */
export function PageToolbar(props: {
  nav: ReactNode;
  address: ReactNode;
  actions?: ReactNode;
  /** What is loading, for the progress bar's name; no bar when undefined. */
  progress?: string | undefined;
}) {
  return (
    <TooltipSide value="top">
      <div
        style={columns}
        className="@container relative grid h-11 shrink-0 items-center gap-2 border-b px-2"
      >
        {props.nav}
        {props.address}
        <div className="flex shrink-0 items-center justify-end gap-1.5">{props.actions}</div>
        {props.progress !== undefined && (
          <span
            role="progressbar"
            aria-label={props.progress}
            className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
          >
            <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-foreground/70" />
          </span>
        )}
      </div>
    </TooltipSide>
  );
}

/** A round button on its own (Annotate, ⋯): the pill's size, alone. */
export const roundButton = "size-8 rounded-full bg-foreground/5 hover:bg-foreground/10";
/** A round control inside a `ToolPill`. */
export const toolbarButton = tool;
