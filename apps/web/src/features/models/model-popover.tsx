import { effortLabel } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";

/** Model, account and effort share one menu, with unavailable tuning controls omitted. */
export function ModelPopover(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  onClose(): void;
}) {
  const { view, actions } = props;
  return (
    <div className="flex flex-col">
      {view.offline && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {view.offline}
        </p>
      )}
      <ModelPickerPanel
        models={view.models}
        providers={view.providers}
        current={view.modelKey}
        currentInstance={view.instance}
        currentProvider={view.provider}
        catalog={view.catalog}
        onClose={props.onClose}
        onPick={(key, instance) => {
          if (!actions.onModel(key, instance) || view.unavailable) props.onClose();
        }}
      />
      {(view.efforts.length > 1 || !view.fastReason || view.canReset) && (
        <div className="flex flex-wrap items-center gap-2 border-t p-2">
          {view.efforts.length > 1 && !view.effortReason && (
            <>
              <span className="text-xs text-muted-foreground">Effort</span>
              <SegmentedControl
                label="Effort"
                size="sm"
                value={view.effort ?? ""}
                options={view.efforts.map((value) => ({ value, label: effortLabel(value) }))}
                onValueChange={actions.onEffort}
              />
            </>
          )}
          {!view.fastReason && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={view.fast}
              onClick={() => actions.onFast(!view.fast)}
            >
              Fast
            </Button>
          )}
          {view.canReset && (
            <Button variant="ghost" size="sm" onClick={actions.onReset}>
              Reset
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
