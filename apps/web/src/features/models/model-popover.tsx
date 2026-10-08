import { effortLabel } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CaretRightIcon, LightningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { StepSlider } from "@/components/ui/step-slider.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { titleWhenClipped } from "@/lib/clipped-title.ts";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";

const iconButton =
  "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:bg-accent aria-pressed:text-foreground data-disabled:opacity-40";

/** The slider's "Default" stop: the provider's own default effort. Never an effort's name. */
const defaultStep = "";
const stepLabel = (step: string) => (step === defaultStep ? "Default" : effortLabel(step));

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
  const steps = view.defaultStop && efforts.length ? [defaultStep, ...efforts] : efforts;
  const index = steps.indexOf(view.effort ?? defaultStep);

  return (
    <div className="flex w-70 flex-col gap-3 p-3">
      <div className="flex min-w-0 items-center gap-1">
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
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <h3 className="min-w-0 max-w-full">
            <button
              type="button"
              aria-label={`Change model: ${view.label ?? ""}`}
              onClick={props.onModels}
              className="inline-flex h-8 max-w-full items-center gap-1 rounded-sm px-2 text-md font-semibold outline-none hover:bg-accent focus-ring"
            >
              {view.provider && <ProviderIcon provider={view.provider} size={12} decorative />}
              <span className="truncate" onPointerEnter={titleWhenClipped(view.label ?? "")}>
                {view.label}
              </span>
              <CaretRightIcon aria-hidden size={10} weight="bold" className="shrink-0" />
            </button>
          </h3>
          {efforts.length > 0 && (
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {view.effort
                ? `${effortLabel(view.effort)} effort${view.effortDefault ? " · default" : ""}`
                : "Default effort"}
            </span>
          )}
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
        <DisabledReason reason={view.effortReason}>
          <StepSlider
            label="Effort"
            steps={steps}
            value={Math.max(0, index)}
            stepLabel={stepLabel}
            disabled={!!view.effortReason}
            onValueChange={(next) => {
              const effort = steps[next];
              if (effort !== undefined && effort !== (view.effort ?? defaultStep))
                actions.onEffort(effort === defaultStep ? undefined : effort);
            }}
          />
        </DisabledReason>
      )}
      {efforts.length > 0 && view.effortReason && (
        <p className="text-center text-xs text-subtle-foreground">{view.effortReason}</p>
      )}
    </div>
  );
}
