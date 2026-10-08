import {
  choiceForModel,
  currentModelChoice,
  pickerModelsFromChoices,
  pickerProviders,
  recordedChoice,
} from "@ace/ui-core";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import { useModelChoices, useModelCatalogState } from "@/features/models/index.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import type { Selection } from "../sources/index.ts";

export function ForkModelPicker(props: {
  selection: Selection | undefined;
  onPick(selection: Selection): void;
  disabled: boolean;
}) {
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const statuses = useProviderStatuses();
  const [open, setOpen] = useState(false);
  const current = currentModelChoice(choices, props.selection);
  const shown = props.selection?.model ? (current ?? recordedChoice(props.selection)) : undefined;
  const models = pickerModelsFromChoices(choices, () => "This account has reached its limit");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" disabled={props.disabled} />}
        aria-label={`Fork model: ${shown?.model ?? "Same as parent"}`}
      >
        Model · {shown?.model ?? "Same as parent"}
      </PopoverTrigger>
      <PopoverContent aria-label="Fork model" className="overflow-hidden p-0">
        <ModelPickerPanel
          models={models}
          providers={pickerProviders(models, statuses.data ?? [])}
          catalog={catalog}
          current={current?.key}
          currentInstance={props.selection?.instanceId}
          currentProvider={props.selection?.provider}
          onPick={(key, instance) => {
            const choice = choiceForModel(choices, key, instance);
            if (!choice) return;
            props.onPick({
              provider: choice.provider,
              model: choice.modelId,
              instanceId: instance ?? choice.accountId,
              options: {},
            });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
