import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { CaretDownIcon, ClockIcon } from "@phosphor-icons/react";
import { Suspense, useState, type ReactElement } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { ReasoningControl } from "./reasoning-control.tsx";

/** The model picker loads on hover, focus or idle. */
const DeferredModelPopover = deferredComponent(() =>
  import("./model-popover.tsx").then((module) => module.ModelPopover),
);

export function preloadModelControl(): Promise<unknown> {
  return DeferredModelPopover.preload();
}
const warm = () => void preloadModelControl();

/**
 * The model and effort have independent compact chips. A pending switch shows its target;
 * the former model remains in the full tooltip. Both popovers stay anchored as the pane resizes.
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
    <>
      <Popover open={open || requested} onOpenChange={changeOpen}>
        <ModelTip label={tip} disabled={open || requested}>
          <PopoverTrigger
            disabled={view.disabled}
            aria-label={view.ariaLabel}
            aria-description={switching?.description}
            onPointerEnter={warm}
            onFocus={warm}
            className={cn(
              props.className,
              "max-w-64 gap-1.5 text-ui leading-4 font-normal focus-ring-inset max-sm:shrink-0",
            )}
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
            {switching && (
              <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
            )}
            <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          </PopoverTrigger>
        </ModelTip>
        <PopoverContent
          side={view.side ?? "top"}
          align="start"
          sideOffset={8}
          aria-label="Choose model"
          className="overflow-hidden p-0 duration-(--motion-fast) motion-reduce:transition-none"
        >
          <Suspense
            fallback={
              // Reserve the model pane's footprint while its code arrives.
              <div className="grid h-107 w-115 max-w-[calc(100vw-2rem)] place-items-center">
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
      {view.label && view.efforts.length > 0 && (
        <ReasoningControl
          view={view}
          actions={props.actions}
          onModels={() => changeOpen(true)}
          className={props.className}
        />
      )}
    </>
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
