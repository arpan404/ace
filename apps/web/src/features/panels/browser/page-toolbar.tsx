import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { TooltipSide } from "@/components/ui/tooltip.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";

const tool = "size-7 rounded-sm";
/** What a toolbar narrower than 28rem leaves out so the address keeps its room. */
export const narrowHidden = "@max-[28rem]:hidden";
/** Navigation, the address taking the room that is left, the tab's actions. */
const columns = { gridTemplateColumns: "auto minmax(0, 1fr) auto" };

/** One navigation control: available with `onClick`, else disabled with the reason it isn't. */
export interface NavControl {
  onClick?: (() => void) | undefined;
  /** Why it can't be used now; shown in its tooltip and read with its name. */
  reason?: string | undefined;
  keys?: string | undefined;
}

const label = (name: string, control: NavControl) =>
  control.reason ? `${name} · ${control.reason}` : name;

/**
 * Back, Forward and Reload (Stop while loading, which the relay can't do yet). Every page-like
 * tab draws the same three, so the toolbar never changes shape between a new tab, a page and a
 * preview.
 */
export function PageNav(props: {
  back: NavControl;
  forward: NavControl;
  reload: NavControl;
  stop?: NavControl;
  loading?: boolean;
}) {
  const control = (
    name: string,
    icon: typeof ArrowLeftIcon,
    value: NavControl,
    className?: string,
  ) => (
    <IconButton
      icon={icon}
      label={label(name, value)}
      {...(value.keys ? { keys: value.keys } : {})}
      disabled={!value.onClick || !!value.reason}
      focusableWhenDisabled
      className={className ? `${tool} ${className}` : tool}
      onClick={value.onClick}
    />
  );
  return (
    <div className="flex shrink-0 items-center">
      {control("Back", ArrowLeftIcon, props.back)}
      {/* A narrow toolbar keeps the address's room: Forward stays on ⌘]. */}
      {control("Forward", ArrowRightIcon, props.forward, narrowHidden)}
      {props.loading
        ? control("Stop", XIcon, props.stop ?? {})
        : control("Reload", ArrowClockwiseIcon, props.reload)}
    </div>
  );
}

/**
 * The 40px toolbar over every page-like tab (a new tab, a browser page, a preview, a port):
 * navigation on the left, the address capsule in the room between, the tab's actions on the
 * right, and a thin progress bar along the bottom edge while the page loads.
 */
export function PageToolbar(props: {
  nav: ReactNode;
  address: ReactNode;
  actions?: ReactNode;
  /** What is loading, for the progress bar's name; no bar when undefined. */
  progress?: string | undefined;
  /** An agent drives the page: the toolbar's edge breathes in the working colour. */
  agent?: boolean;
}) {
  return (
    <TooltipSide value="top">
      <div
        style={columns}
        className="@container relative grid h-10 shrink-0 items-center gap-1 border-b px-2"
      >
        {props.nav}
        {props.address}
        <div className="flex shrink-0 items-center justify-end gap-0.5">{props.actions}</div>
        {props.agent && props.progress === undefined && (
          <span
            aria-hidden
            className="absolute inset-x-0 -bottom-px h-px animate-pulse bg-status-working"
          />
        )}
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

export const toolbarButton = tool;
