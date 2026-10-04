import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";

const tool = "size-7 rounded-[7px]";

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
  loading?: boolean;
}) {
  const control = (name: string, icon: typeof ArrowLeftIcon, value: NavControl) => (
    <IconButton
      icon={icon}
      label={label(name, value)}
      {...(value.keys ? { keys: value.keys } : {})}
      disabled={!value.onClick || !!value.reason}
      focusableWhenDisabled
      className={tool}
      onClick={value.onClick}
    />
  );
  return (
    <div className="flex min-w-22 shrink-0 items-center">
      {control("Back", ArrowLeftIcon, props.back)}
      {control("Forward", ArrowRightIcon, props.forward)}
      {props.loading
        ? control("Stop", XIcon, {
            reason: "the browser relay can't cancel a load yet; it gives up after 30 seconds",
          })
        : control("Reload", ArrowClockwiseIcon, props.reload)}
    </div>
  );
}

/**
 * The 40px toolbar over every page-like tab (a new tab, a browser page, a preview, a port):
 * navigation on the left, the address capsule centred at up to 640px, the tab's actions on the
 * right, and a thin progress bar along the bottom edge while the page loads.
 */
export function PageToolbar(props: {
  nav: ReactNode;
  address: ReactNode;
  actions?: ReactNode;
  /** What is loading, for the progress bar's name; no bar when undefined. */
  progress?: string | undefined;
}) {
  return (
    <div className="relative grid h-10 shrink-0 grid-cols-[1fr_minmax(0,640px)_1fr] items-center gap-1 border-b px-2">
      {props.nav}
      {props.address}
      {/* As wide as the navigation at least, so the address sits on the toolbar's centre. */}
      <div className="flex min-w-22 shrink-0 items-center justify-end gap-0.5">{props.actions}</div>
      {props.progress !== undefined && (
        <span
          role="progressbar"
          aria-label={props.progress}
          className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
        >
          <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-foreground/50" />
        </span>
      )}
    </div>
  );
}

export const toolbarButton = tool;
