import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";

/** The model menu only selects a model and account; effort has its own popover. */
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
          actions.onModel(key, instance);
          props.onClose();
        }}
      />
    </div>
  );
}
