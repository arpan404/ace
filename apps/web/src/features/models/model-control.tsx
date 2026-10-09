import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { effortLabel } from "@ace/ui-core";
import { CaretDownIcon, ClockIcon, LightningIcon } from "@phosphor-icons/react";
import { Suspense, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";

/** The popover's effort, speed, account and model picker: loaded on hover, focus or idle. */
const DeferredModelPopover = deferredComponent(() =>
  import("./model-popover.tsx").then((module) => module.ModelPopover),
);

export function preloadModelControl(): Promise<unknown> {
  return DeferredModelPopover.preload();
}
const warm = () => void preloadModelControl();

/**
 * The composer's model, as plain text: "Opus 4.1 High ▾", the model in the ink colour and its
 * effort a step quieter (the model alone when the composer is narrow). A switch not in effect yet reads
 * "Opus 4.1 → Sonnet 4.5" with a small clock. It opens a small popover with effort, speed, the
 * account and the way to another model, anchored to this control even as the pane resizes.
 */
export function ModelControl(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  /** The composer's chip style, which its other footer controls share. */
  className: string;
  compact: boolean;
}) {
  const { view } = props;
  const [open, setOpen] = useState(false);
  const [dismissedRequest, dismissRequest] = useState(0);
  const requested = (view.pickerRequest ?? 0) > dismissedRequest;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) dismissRequest(view.pickerRequest ?? 0);
  };
  const switching = view.switching;
  const tip = [view.offline ?? view.tip, switching?.description].filter(Boolean).join(" · ");
  return (
    <Popover open={open || requested} onOpenChange={changeOpen}>
      <Tip label={tip} side="top">
        <PopoverTrigger
          disabled={view.disabled}
          aria-label={view.ariaLabel}
          aria-description={switching?.description}
          onPointerEnter={warm}
          onFocus={warm}
          className={cn(props.className, "max-w-64")}
        >
          {view.provider && (
            <ProviderAccountIcon
              provider={view.provider}
              instance={view.instance ?? view.account}
              size={18}
              accountLabel
            />
          )}
          {!view.label && view.catalog === "loading" && <Spinner />}
          {switching?.from && !props.compact && (
            <span className="min-w-0 shrink-[2] truncate text-subtle-foreground">
              {switching.from} →
            </span>
          )}
          <span className="min-w-0 truncate text-foreground">{view.label ?? view.placeholder}</span>
          {view.unavailable && (
            <span className="shrink-0 text-xs text-status-failed">Unavailable</span>
          )}
          {!props.compact && view.label && view.effort && (
            <span className="shrink-0 font-normal">{effortLabel(view.effort)}</span>
          )}
          {view.fast && <LightningIcon aria-hidden size={12} weight="fill" className="shrink-0" />}
          {switching && (
            <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          )}
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side={view.side ?? "top"}
        align={view.side === "bottom" ? "start" : "end"}
        collisionAvoidance={
          view.side === "bottom"
            ? { side: "none", align: "shift", fallbackAxisSide: "none" }
            : undefined
        }
        sideOffset={8}
        aria-label="Model and effort"
        className="overflow-hidden p-0 duration-(--dur-1)"
      >
        <Suspense
          fallback={
            // The effort pane's footprint, so the popover doesn't jump when its code arrives.
            <div className="grid h-32 w-70 place-items-center">
              <Spinner label="Loading" />
            </div>
          }
        >
          <DeferredModelPopover.Component
            view={view}
            actions={props.actions}
            onClose={() => changeOpen(false)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
