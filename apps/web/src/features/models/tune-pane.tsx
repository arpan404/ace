import { effortLabel, speedLabel, type Speed } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useId, type KeyboardEvent } from "react";
import { StepSlider } from "@/components/ui/step-slider.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { isDeepReasoning, reasoningDescription } from "./reasoning-level.ts";
import { SpeedGlyph } from "./speed-glyph.tsx";

const iconButton =
  "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground focus-ring-inset transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground data-disabled:opacity-40";

/** The model has something to tune here: effort levels, or more than one speed. */
export function tunable(view: Pick<ModelControlView, "efforts" | "speeds">): boolean {
  return view.efforts.length > 0 || view.speeds.length > 1;
}

/**
 * The model popover's first pane: speed on the left (one icon per tier the catalog offers), the
 * effort in the accent with the model under it (which opens the picker), Reset on the right, and
 * the effort slider over the model's own levels with its default stop marked. Ultra and Max get
 * the deep-reasoning thumb.
 */
export function TunePane(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onModels(): void;
}) {
  const { view, actions } = props;
  const efforts = view.efforts;
  const index = view.effort === undefined ? -1 : efforts.indexOf(view.effort);
  const defaultIndex = view.defaultEffort === undefined ? -1 : efforts.indexOf(view.defaultEffort);
  const deep = isDeepReasoning(view.effort, efforts);
  const resettable = view.canReset && !view.effortReason;
  const description = useId();
  return (
    <div className="flex w-72 max-w-[calc(100vw-24px)] flex-col gap-3 p-3">
      <div className="flex min-w-0 items-start gap-1">
        {view.speeds.length > 1 ? (
          <SpeedSegment view={view} onSpeed={actions.onSpeed} />
        ) : (
          <span aria-hidden className="size-8 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
          {efforts.length > 0 && (
            <Tip label={view.effortReason ?? reasoningDescription(view.effort)} side="top">
              <span
                aria-live="polite"
                className={cn(
                  "text-ui font-medium",
                  deep ? "model-effort-deep fx-flourish" : "text-link",
                )}
              >
                {view.effort ? effortLabel(view.effort) : "Choose effort"}
              </span>
            </Tip>
          )}
          <h3 className="max-w-full min-w-0">
            <Tip label={view.tip} side="top">
              <button
                type="button"
                aria-label={`Change model: ${view.label ?? ""}`}
                onClick={props.onModels}
                className="flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm px-1 text-sm text-muted-foreground focus-ring-inset hover:bg-accent hover:text-foreground"
              >
                <span className="min-w-0 truncate">{view.label}</span>
                <CaretRightIcon aria-hidden size={12} className="shrink-0" />
              </button>
            </Tip>
          </h3>
        </div>
        <Tip
          label={
            view.canReset
              ? "Back to the model's default effort"
              : "Already using the model's default effort"
          }
          side="top"
        >
          <button
            type="button"
            aria-label="Reset effort"
            aria-disabled={resettable ? undefined : true}
            data-disabled={resettable ? undefined : ""}
            onClick={() => {
              if (resettable) actions.onEffort(undefined);
            }}
            className={iconButton}
          >
            <ArrowCounterClockwiseIcon aria-hidden size={16} />
          </button>
        </Tip>
      </div>
      {efforts.length > 1 && (
        <>
          <StepSlider
            label="Effort"
            describedBy={description}
            steps={efforts}
            value={index >= 0 ? index : undefined}
            defaultIndex={defaultIndex >= 0 ? defaultIndex : undefined}
            unselectedLabel="Choose effort"
            stepLabel={effortLabel}
            quietFocus
            gradient
            deepReasoning={deep}
            disabled={!!view.effortReason}
            className="py-0.5"
            onValueChange={(next) => {
              const step = efforts[next];
              if (step !== undefined && !view.effortReason && step !== view.effort)
                actions.onEffort(step);
            }}
          />
          <p id={description} className="sr-only">
            {view.effortReason ?? reasoningDescription(view.effort)}
            {view.defaultEffort && ` The model's default is ${effortLabel(view.defaultEffort)}.`}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The catalog's speeds as icon-only radios, slowest first. Arrow keys move between them; a
 * thread whose provider sets speed only at start shows them disabled with the reason.
 */
function SpeedSegment(props: { view: ModelControlView; onSpeed(speed: Speed): void }) {
  const { speeds, speed, speedReason } = props.view;
  const choose = (next: Speed) => {
    if (!speedReason && next !== speed) props.onSpeed(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = speeds.findIndex((tier) => tier.speed === speed);
    const next = speeds[(at + step + speeds.length) % speeds.length];
    if (!next) return;
    choose(next.speed);
    event.currentTarget
      .querySelector<HTMLElement>(`[data-speed="${next.speed}"]`)
      ?.focus({ preventScroll: true });
  };
  return (
    <div
      role="radiogroup"
      aria-label="Speed"
      aria-disabled={speedReason ? true : undefined}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-secondary p-0.5"
    >
      {speeds.map((tier) => {
        const checked = tier.speed === speed;
        return (
          <Tip key={tier.speed} label={speedReason ?? speedLabel(tier.speed)} side="top">
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={speedLabel(tier.speed)}
              aria-disabled={speedReason ? true : undefined}
              data-speed={tier.speed}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(tier.speed)}
              className={cn(
                "grid size-7 place-items-center rounded-full pointer-coarse:size-8 text-muted-foreground focus-ring-inset transition-[background-color,color] duration-(--motion-fast) hover:text-foreground aria-disabled:opacity-40",
                checked && "bg-popover text-foreground shadow-raised",
              )}
            >
              <SpeedGlyph speed={tier.speed} size={14} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
