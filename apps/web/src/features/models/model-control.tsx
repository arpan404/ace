import { effortLabel } from "@ace/ui-core";
import { CaretDownIcon, ClockIcon, LightningIcon } from "@phosphor-icons/react";
import { Suspense, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { anchorAbove } from "@/lib/popover-anchor.ts";
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
 * The composer's model chip, "◆ Opus 4.1 · High ▾": the provider's mark, the model and its
 * effort (the model alone when the composer is narrow). A switch not in effect yet reads
 * "Opus 4.1 → Sonnet 4.5" with a small clock. It opens a small popover with effort, speed, the
 * account and the way to another model, above the composer rather than over it.
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
  const trigger = useRef<HTMLButtonElement>(null);
  const switching = view.switching;
  const tip = [view.offline ?? view.tip, switching?.description].filter(Boolean).join(" · ");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={tip} side="top">
        <PopoverTrigger
          ref={trigger}
          disabled={view.disabled}
          aria-label={view.ariaLabel}
          aria-description={switching?.description}
          onPointerEnter={warm}
          onFocus={warm}
          className={cn(props.className, "max-w-64")}
        >
          {view.provider ? (
            <ProviderIcon provider={view.provider} size={14} decorative />
          ) : (
            view.catalog === "loading" && <Spinner />
          )}
          {switching?.from && !props.compact && (
            <span className="min-w-0 shrink-[2] truncate text-subtle-foreground">
              {switching.from} →
            </span>
          )}
          <span className="min-w-0 truncate">{view.label ?? view.placeholder}</span>
          {!props.compact && view.label && view.effort && (
            <span className="shrink-0 font-normal text-subtle-foreground">
              · {effortLabel(view.effort)}
            </span>
          )}
          {view.fast && <LightningIcon aria-hidden size={12} weight="fill" className="shrink-0" />}
          {switching && (
            <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          )}
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        anchor={() => anchorAbove(trigger.current, "[data-slot=composer]")}
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
            onClose={() => setOpen(false)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
