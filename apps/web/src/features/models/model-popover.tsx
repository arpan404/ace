import { effortLabel } from "@ace/ui-core";
import { ArrowCounterClockwiseIcon, CaretRightIcon, LightningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { StepSlider } from "@/components/ui/step-slider.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { AccountRow, ModelControlActions, ModelControlView } from "./control-view.ts";
import { ModelPickerPanel } from "./model-picker-panel.tsx";

const iconButton =
  "grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:bg-accent aria-pressed:text-foreground data-disabled:opacity-40";

/**
 * The model chip's popover. First effort and speed for the chosen model ("Medium", the model's
 * name, the slider), then, from the name, the model picker; choosing a model comes back here.
 */
export function ModelPopover(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onClose(): void;
}) {
  const { view, actions } = props;
  // Without a model there is nothing to tune yet: start at the picker.
  const [pane, setPane] = useState<"effort" | "picker">(view.label ? "effort" : "picker");
  if (view.offline)
    return (
      <p role="status" className="max-w-64 px-3 py-2.5 text-xs leading-4 text-muted-foreground">
        {view.offline}
      </p>
    );
  if (pane === "picker")
    return (
      <ModelPickerPanel
        models={view.models}
        providers={view.providers}
        current={view.modelKey}
        currentProvider={view.provider}
        onPick={(key) => {
          if (key !== view.modelKey && !actions.onModel(key)) props.onClose();
          else setPane("effort");
        }}
      />
    );
  return <EffortPanel view={view} actions={actions} onModels={() => setPane("picker")} />;
}

function EffortPanel(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onModels(): void;
}) {
  const { view, actions } = props;
  const efforts = view.efforts;
  const index = view.effort ? efforts.indexOf(view.effort) : -1;
  const title = view.effort ? effortLabel(view.effort) : "Default effort";
  return (
    <div className="flex w-[280px] flex-col gap-3 p-3">
      <div className="flex items-start gap-1">
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
        <div className="flex min-w-0 flex-1 flex-col items-center pt-0.5">
          <span className="text-md font-medium text-foreground">
            {title}
            {view.effort && view.effortDefault && (
              <span className="font-normal text-subtle-foreground"> · default</span>
            )}
          </span>
          <button
            type="button"
            aria-label={`Change model: ${view.label ?? ""}`}
            onClick={props.onModels}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 text-ui text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
          >
            {view.provider && <ProviderIcon provider={view.provider} size={12} decorative />}
            <span className="truncate">{view.label}</span>
            <CaretRightIcon aria-hidden size={12} className="shrink-0" />
          </button>
        </div>
        <Tip label="Back to the model's defaults" side="top">
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
      </div>
      {view.accounts.length > 1 && (
        <Accounts accounts={view.accounts} value={view.account} onChange={actions.onAccount} />
      )}
      {efforts.length > 1 && (
        <StepSlider
          label="Effort"
          steps={efforts}
          value={index}
          stepLabel={effortLabel}
          disabled={!!view.effortReason}
          onValueChange={(next) => {
            const effort = efforts[next];
            if (effort && effort !== view.effort) actions.onEffort(effort);
          }}
        />
      )}
      {(view.effortReason || efforts.length < 2) && (
        <p className="text-center text-xs text-subtle-foreground">
          {view.effortReason ?? `${view.label ?? "This model"} has one effort level`}
        </p>
      )}
    </div>
  );
}

/** Which account runs the model: a row of small pills, each with its usage on hover. */
function Accounts(props: {
  accounts: readonly AccountRow[];
  value: string | undefined;
  onChange(id: string): void;
}) {
  return (
    <div role="group" aria-label="Account" className="flex flex-wrap justify-center gap-1">
      {props.accounts.map((account) => (
        <Tip key={account.id} label={account.disabled ?? account.detail} side="bottom">
          <button
            type="button"
            aria-pressed={account.id === props.value}
            aria-label={`Account ${account.label}`}
            aria-disabled={account.disabled ? true : undefined}
            data-disabled={account.disabled ? "" : undefined}
            onClick={() => {
              if (!account.disabled && account.id !== props.value) props.onChange(account.id);
            }}
            className="h-[26px] rounded-full px-2.5 text-[12px] font-medium text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:bg-accent aria-pressed:text-foreground data-disabled:opacity-40"
          >
            {account.label}
          </button>
        </Tip>
      ))}
    </div>
  );
}
