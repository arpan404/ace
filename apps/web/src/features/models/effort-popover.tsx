import { effortLabel } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CaretRightIcon, LightningIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { StepSlider } from "@/components/ui/step-slider.tsx";
import { isDeepReasoning, reasoningDescription } from "./reasoning-level.ts";

const iconButton =
  "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground focus-ring-inset transition-colors duration-(--dur-1) motion-reduce:transition-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground data-disabled:opacity-40";

export function EffortPopover(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onModels(): void;
}) {
  const { view, actions } = props;
  const efforts = view.efforts;
  const tunable = efforts.length > 0 || !view.fastReason;
  const steps = efforts;
  const selected = view.effort;
  const index = selected === undefined ? -1 : steps.indexOf(selected);
  const description = useId();
  const choose = (effort: string) => {
    if (!view.effortReason && effort !== selected) actions.onEffort(effort);
  };

  return (
    <div className="flex w-72 max-w-[calc(100vw-24px)] flex-col gap-3 p-3">
      <div className="flex min-w-0 items-start gap-1">
        {tunable && (
          <Tip label={view.fastReason ?? (view.fast ? "Fast: on" : "Fast: off")} side="top">
            <button
              type="button"
              aria-label="Fast mode"
              aria-pressed={view.fast}
              aria-disabled={view.fastReason ? true : undefined}
              data-disabled={view.fastReason ? "" : undefined}
              onClick={() => {
                if (!view.fastReason) actions.onFast(!view.fast);
              }}
              className={iconButton}
            >
              <LightningIcon aria-hidden size={16} weight={view.fast ? "fill" : "regular"} />
            </button>
          </Tip>
        )}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
          {efforts.length > 0 && (
            <Tip label={view.effortReason ?? reasoningDescription(view.effort)} side="top">
              <span
                aria-live="polite"
                className={
                  isDeepReasoning(view.effort, efforts)
                    ? "reasoning-deep-heading text-ui font-medium"
                    : "text-ui font-medium text-link"
                }
              >
                {view.effort ? effortLabel(view.effort) : "Select effort"}
              </span>
            </Tip>
          )}
          <h3 className="min-w-0 max-w-full">
            <Tip label={view.tip} side="top">
              <button
                type="button"
                aria-label={`Change model: ${view.label ?? ""}`}
                onClick={props.onModels}
                className="flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm px-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-ring-inset"
              >
                <span className="min-w-0 truncate">{view.label}</span>
                <CaretRightIcon aria-hidden size={12} className="shrink-0 text-muted-foreground" />
              </button>
            </Tip>
          </h3>
        </div>
        {tunable && (
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
              aria-disabled={view.canReset && !view.effortReason ? undefined : true}
              data-disabled={view.canReset && !view.effortReason ? undefined : ""}
              onClick={() => {
                if (view.canReset && !view.effortReason) actions.onEffort(undefined);
              }}
              className={iconButton}
            >
              <ArrowCounterClockwiseIcon aria-hidden size={16} />
            </button>
          </Tip>
        )}
      </div>
      {steps.length > 0 && (
        <StepSlider
          label="Effort"
          describedBy={description}
          steps={steps}
          value={index >= 0 ? index : undefined}
          unselectedLabel="Select effort"
          stepLabel={effortLabel}
          showLabels={false}
          gradient
          deepReasoning={isDeepReasoning(view.effort, efforts)}
          disabled={!!view.effortReason}
          className="py-0.5"
          onValueChange={(next) => {
            const step = steps[next];
            if (step !== undefined) choose(step);
          }}
        />
      )}
      {steps.length > 0 && (
        <p id={description} className="sr-only">
          {view.effortReason ?? reasoningDescription(view.effort)}
        </p>
      )}
    </div>
  );
}
