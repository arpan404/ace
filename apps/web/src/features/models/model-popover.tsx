import { useEffect, useState } from "react";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { TunePane, tunable } from "./tune-pane.tsx";

/**
 * The model chip's one popover. It opens on Tune (speed, effort), whose model name opens the
 * provider and model list; picking a model comes back to Tune on that model's default effort.
 * Without a model, or one with nothing to tune, it opens on the list, and a pick closes it.
 */
export function ModelPopover(props: {
  view: ModelControlView;
  actions: ModelControlActions;
  /** Where it opens: Tune from the chip, the list when asked for it (⌘K "Switch model…"). */
  initialPane: "tune" | "picker";
  onClose(): void;
}) {
  const { view, actions } = props;
  // Without a model there is nothing to tune yet: start at the picker.
  const [pane, setPane] = useState<"tune" | "picker">(() =>
    props.initialPane === "tune" && view.label && !view.unavailable && tunable(view)
      ? "tune"
      : "picker",
  );
  // A model was just picked: Tune shows it, or the popover closes when it has nothing to tune.
  const [landed, setLanded] = useState(false);
  const empty = landed && pane === "tune" && !tunable(view);
  const { onClose } = props;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  // Offline, changes still go (effort and speed with the next message, a switch from the
  // outbox): say when they apply above whatever the popover shows.
  const offline = view.offline && (
    <p role="status" className="px-3 pt-2.5 text-center text-xs leading-4 text-muted-foreground">
      {view.offline}
    </p>
  );
  return (
    // Each pane fades in as the popover resizes to it.
    <div key={pane} className="fx-view-in">
      {offline}
      {pane === "picker" || empty ? (
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
            // Another provider asks first (a dialog), and an unavailable model has no Tune.
            if (!same && !actions.onModel(key, instance)) return props.onClose();
            setLanded(true);
            setPane("tune");
          }}
        />
      ) : (
        <TunePane view={view} actions={actions} onModels={() => setPane("picker")} />
      )}
    </div>
  );
}
