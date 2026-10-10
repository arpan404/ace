import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { effortLabel } from "@ace/ui-core";
import { CaretDownIcon, ClockIcon, LightningIcon } from "@phosphor-icons/react";
import { Suspense, useState, type ReactElement } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { isDeepReasoning, reasoningShortLabel } from "./reasoning-level.ts";

/** The popover's effort, speed, account and model picker: loaded on hover, focus or idle. */
const DeferredModelPopover = deferredComponent(() =>
  import("./model-popover.tsx").then((module) => module.ModelPopover),
);

export function preloadModelControl(): Promise<unknown> {
  return DeferredModelPopover.preload();
}
const warm = () => void preloadModelControl();

/**
 * The model name yields space to fixed effort and Fast indicators. A pending switch shows
 * its target; the former model remains in the full tooltip. It opens a popover with effort, speed, the
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
  const tip = [
    view.tip,
    view.offline,
    switching?.from && `Previously ${switching.from}`,
    switching?.description,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Popover open={open || requested} onOpenChange={changeOpen}>
      <ModelTip label={tip} disabled={open || requested}>
        <PopoverTrigger
          disabled={view.disabled}
          aria-label={view.ariaLabel}
          aria-description={switching?.description}
          onPointerEnter={warm}
          onFocus={warm}
          className={cn(props.className, "max-w-64 gap-1.5 text-sm leading-4")}
        >
          {view.provider && (
            <ProviderAccountIcon
              provider={view.provider}
              instance={view.instance ?? view.account}
              size={14}
              accountLabel
            />
          )}
          {!view.label && view.catalog === "loading" && <Spinner />}
          <span data-slot="model-name" className="min-w-0 flex-1 truncate text-foreground">
            {view.label ?? view.placeholder}
          </span>
          {view.unavailable && (
            <span className="shrink-0 text-xs text-status-failed">Unavailable</span>
          )}
          {view.label && view.effort !== undefined && view.efforts.length > 1 && (
            <ReasoningSignal view={view} disabled={open || requested} />
          )}
          {view.fast && (
            <ModelTip label="Fast: on" disabled={open || requested}>
              <span role="img" aria-label="Fast: on" className="inline-flex shrink-0">
                <LightningIcon aria-hidden size={12} weight="fill" />
              </span>
            </ModelTip>
          )}
          {switching && (
            <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          )}
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </PopoverTrigger>
      </ModelTip>
      <PopoverContent
        side={view.side ?? "top"}
        align={view.side === "bottom" ? "start" : "end"}
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

/** Only a known actual thinking level gets a chip indicator. */
function ReasoningSignal(props: { view: ModelControlView; disabled: boolean }) {
  const { efforts, effort, effortDefault } = props.view;
  if (effort === undefined) return null;
  const label = `${effortLabel(effort)} reasoning${effortDefault ? " · default" : ""}`;
  return (
    <ModelTip label={label} disabled={props.disabled}>
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center gap-1">
        <span aria-hidden className="text-subtle-foreground">
          ·
        </span>
        <span className={isDeepReasoning(effort, efforts) ? "model-deep-reasoning" : undefined}>
          {reasoningShortLabel(effort)}
        </span>
      </span>
    </ModelTip>
  );
}

/** The model popup owns descriptions while open, including a tooltip already showing. */
function ModelTip(props: { label: string; disabled: boolean; children: ReactElement }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Tooltip open={!props.disabled && hovered} onOpenChange={setHovered}>
      <TooltipTrigger render={props.children} closeOnClick />
      <TooltipContent side="top">{props.label}</TooltipContent>
    </Tooltip>
  );
}
