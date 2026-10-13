import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { effortLabel, speedLabel } from "@ace/ui-core";
import { CaretDownIcon, ClockIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useEffectEvent, useState, type ReactElement } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { isDeepReasoning, reasoningShortLabel } from "./reasoning-level.ts";
import { SpeedGlyph } from "./speed-glyph.tsx";

/** The popover's Tune and Picker panes: loaded on hover, focus or idle. */
const DeferredModelPopover = deferredComponent(() =>
  import("./model-popover.tsx").then((module) => module.ModelPopover),
);

export function preloadModelControl(): Promise<unknown> {
  return DeferredModelPopover.preload();
}
const warm = () => void preloadModelControl();

/**
 * The composer's one model control: `[logo] Model · Effort [speed] ⌄`. Clicking the model's
 * name (or opening it from the keyboard) shows the model list; clicking its effort half (the
 * effort, the speed and the caret) shows Tune. The model name gives way
 * first; the effort and the speed icon never do. Standard speed has no icon, Fast one bolt,
 * Ultrafast two. A pending switch shows its target, the former model in the tooltip. It opens
 * one popover, always upward, anchored to the chip as the pane resizes.
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
  // The name opens the model list; the effort and speed open Tune. One chip, one popover.
  const [pane, setPane] = useState<"tune" | "picker">("picker");
  const choosePane = (event: { target: EventTarget }) => {
    const target = event.target instanceof Element ? event.target : null;
    setPane(target?.closest("[data-model-tune]") ? "tune" : "picker");
  };
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
  const showing = open || requested;
  // Escape closes the popover wherever focus is, including after a pick swaps the picker for
  // Tune and the focused row goes away.
  const close = useEffectEvent(() => changeOpen(false));
  useEffect(() => {
    if (!showing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    // Capture: a tooltip on the focused control would otherwise keep the key to itself.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [showing]);
  return (
    <Popover open={showing} onOpenChange={changeOpen}>
      <ModelTip label={tip} disabled={showing}>
        <PopoverTrigger
          disabled={view.disabled}
          aria-label={view.ariaLabel}
          aria-description={switching?.description}
          onPointerEnter={warm}
          onFocus={warm}
          // Pointer down too: the popover may open on press, before the click lands.
          onPointerDown={choosePane}
          onClick={choosePane}
          className={cn(
            props.className,
            "max-w-72 gap-1.5 text-ui leading-4 font-normal focus-ring-inset",
          )}
        >
          {view.provider && (
            <ProviderAccountIcon
              provider={view.provider}
              instance={view.instance ?? view.account}
              size={14}
              // A compact composer keeps the room for the model's name.
              accountLabel={!props.compact}
            />
          )}
          {!view.label && view.catalog === "loading" && <Spinner />}
          <span data-slot="model-name" className="min-w-0 flex-1 truncate text-foreground">
            {view.label ?? view.placeholder}
          </span>
          {view.unavailable && (
            <span className="shrink-0 text-xs text-status-failed">Unavailable</span>
          )}
          {/* The chip's effort half: everything after the name, out to its right edge (the
              caret and the padding included), opens Tune for every model that has one. */}
          <span
            data-model-tune
            className="-mr-2.5 inline-flex shrink-0 items-center gap-1.5 self-stretch pr-2.5"
          >
            {view.label && view.effort !== undefined && view.efforts.length > 0 && (
              <EffortSignal view={view} compact={props.compact} />
            )}
            {view.label && view.speed !== "standard" && (
              <span
                role="img"
                aria-label={speedLabel(view.speed)}
                className={cn(
                  "inline-flex shrink-0",
                  view.speed === "ultrafast" ? "text-link" : "text-muted-foreground",
                )}
              >
                <SpeedGlyph speed={view.speed} size={13} />
              </span>
            )}
            {switching && (
              <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
            )}
            <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          </span>
        </PopoverTrigger>
      </ModelTip>
      <PopoverContent
        // Above the composer on every page: below it there is no room, and New thread's
        // composer sits low enough that a downward popover was cut off.
        side="top"
        align="end"
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        sideOffset={8}
        aria-label="Model and effort"
        className="model-popover overflow-hidden p-0 duration-(--motion-fast)"
      >
        <Suspense
          fallback={
            // The Tune pane's footprint, so the popover doesn't jump when its code arrives.
            <div className="grid h-32 w-72 place-items-center">
              <Spinner label="Loading" />
            </div>
          }
        >
          <DeferredModelPopover.Component
            view={view}
            actions={props.actions}
            initialPane={requested ? "picker" : pane}
            onClose={() => changeOpen(false)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The effort in effect, after a dot: "· High", or "· Med" on a compact composer. Ultra and Max
 * get the accent sheen.
 */
function EffortSignal(props: { view: ModelControlView; compact: boolean }) {
  const { efforts, effort } = props.view;
  if (effort === undefined) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <span
        data-slot="model-effort"
        className={
          isDeepReasoning(effort, efforts)
            ? "model-effort-deep fx-flourish"
            : "text-muted-foreground"
        }
      >
        {props.compact ? reasoningShortLabel(effort) : effortLabel(effort)}
      </span>
    </span>
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
