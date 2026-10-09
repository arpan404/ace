import { effortLabel } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CaretRightIcon, LightningIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import { StepSlider } from "@/components/ui/step-slider.tsx";
import { isDeepReasoning, reasoningDescription } from "./reasoning-level.ts";

const iconButton =
  "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground data-disabled:opacity-40";

/**
 * The model chip's popover. The model name opens the picker; account, effort and speed stay below it.
 * Choosing a model comes back here.
 */
export function ModelPopover(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onClose(): void;
}) {
  const { view, actions } = props;
  // Without a model there is nothing to tune yet: start at the picker.
  const [pane, setPane] = useState<"effort" | "picker">(
    view.label && !view.unavailable ? "effort" : "picker",
  );
  // Offline, changes still go (effort and speed with the next message, a switch from the
  // outbox): say when they apply above whatever the popover shows.
  const offline = view.offline && (
    <p role="status" className="px-3 pt-2.5 text-center text-xs leading-4 text-muted-foreground">
      {view.offline}
    </p>
  );
  // Each pane uses the shared view transition as the popover resizes to it.
  return (
    <div key={pane} className="fx-view-in">
      {offline}
      {pane === "picker" ? (
        <ModelPickerPanel
          models={view.models}
          providers={view.providers}
          current={view.modelKey}
          currentInstance={view.instance}
          currentProvider={view.provider}
          catalog={view.catalog}
          onClose={props.onClose}
          onPick={(key, instance) => {
            const same = key === view.modelKey && (!instance || instance === view.instance);
            if (!same && (!actions.onModel(key, instance) || view.unavailable)) props.onClose();
            else setPane("effort");
          }}
        />
      ) : (
        <EffortPanel
          view={view}
          actions={actions}
          onModels={() => setPane("picker")}
          onClose={props.onClose}
        />
      )}
    </div>
  );
}

function EffortPanel(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onModels(): void;
  onClose(): void;
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
                {view.effort ? effortLabel(view.effort) : "Choose effort"}
              </span>
            </Tip>
          )}
          <h3 className="min-w-0 max-w-full">
            <Tip label={view.tip} side="top">
              <button
                type="button"
                aria-label={`Change model: ${view.label ?? ""}`}
                onClick={props.onModels}
                className="flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm px-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground outline-none"
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
              view.canReset ? "Back to the model's defaults" : "Already using the model's defaults"
            }
            side="top"
          >
            <button
              type="button"
              aria-label="Reset effort and speed"
              aria-disabled={view.canReset ? undefined : true}
              data-disabled={view.canReset ? undefined : ""}
              onClick={() => {
                if (view.canReset) actions.onReset();
              }}
              className={iconButton}
            >
              <ArrowCounterClockwiseIcon aria-hidden size={16} />
            </button>
          </Tip>
        )}
      </div>
      {steps.length > 1 && (
        <StepSlider
          label="Effort"
          describedBy={description}
          steps={steps}
          value={index >= 0 ? index : undefined}
          unselectedLabel="Choose effort"
          stepLabel={effortLabel}
          showLabels={false}
          quietFocus
          deepReasoning={isDeepReasoning(view.effort, efforts)}
          disabled={!!view.effortReason}
          className="py-0.5"
          onValueChange={(next) => {
            const step = steps[next];
            if (step !== undefined) choose(step);
          }}
        />
      )}
      {steps.length > 1 && (
        <p id={description} className="sr-only">
          {view.effortReason ?? reasoningDescription(view.effort)}
        </p>
      )}
    </div>
  );
}
