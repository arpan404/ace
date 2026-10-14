import { useConnectionState } from "@ace/client-react";
import { choiceForModel, pickerModelsFromChoices, pickerProviders } from "@ace/ui-core";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import { useModelChoices, useModelCatalogState } from "@/features/models/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useUtilityModel } from "@/lib/utility-model.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { SettingSwitch } from "./setting-switch.tsx";

/** Titles and commit/PR drafts: the model they're written with, and drafting on open. */
export function GenerationSettings() {
  const note = useNotConnectedNote();
  return (
    <SettingSection label="Generation" card scope="daemon" note={note}>
      <UtilityModelRow />
      <SettingSwitch setting={settingKeys.autoDraftCommits} entry="generation.autoDraftCommits" />
    </SettingSection>
  );
}

function UtilityModelRow() {
  const row = settingRow("generation.model");
  const [choice, setChoice] = useDaemonSetting("generation.model");
  const write = useSettingWrite(row.title);
  const offline = useConnectionState() !== "ready";
  const resolved = useUtilityModel().model;
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const statuses = useProviderStatuses();
  const [open, setOpen] = useState(false);
  const models = pickerModelsFromChoices(choices, () => "This account has reached its limit");
  const shown = resolved
    ? choices.find(
        (entry) => entry.provider === resolved.provider && entry.modelId === resolved.model,
      )
    : undefined;
  const name = shown?.model ?? resolved?.model;
  const label = choice ? (name ?? choice.model) : name ? `Auto · ${name}` : "Off";
  const pick = (next: Parameters<typeof setChoice>[0]) => {
    setOpen(false);
    write.run(() => setChoice(next));
  };
  return (
    <SettingRow {...row}>
      <DaemonSlot control={{ loaded: choice !== undefined, offline, pending: write.pending }}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button type="button" variant="secondary" size="sm" disabled={offline} />}
            aria-label={`${row.title}: ${label}`}
          >
            {resolved && (
              <ProviderAccountIcon
                provider={resolved.provider}
                instance={resolved.instance}
                size={14}
                accountLabel={false}
              />
            )}
            <span className="max-w-48 truncate">{label}</span>
            <CaretDownIcon aria-hidden size={12} className="text-subtle-foreground" />
          </PopoverTrigger>
          <PopoverContent aria-label={row.title} className="overflow-hidden p-0">
            <button
              type="button"
              aria-pressed={!choice}
              className="flex h-8 w-full items-center gap-2 border-b border-border px-3 text-left text-ui hover:bg-accent focus-ring-inset"
              onClick={() => pick(null)}
            >
              <span className="flex-1">Auto</span>
              {!choice && <CheckIcon aria-hidden size={14} />}
            </button>
            <ModelPickerPanel
              models={models}
              providers={pickerProviders(models, statuses.data ?? [])}
              catalog={catalog}
              current={choice ? shown?.key : undefined}
              currentInstance={choice?.instance ?? resolved?.instance}
              currentProvider={choice?.provider ?? resolved?.provider}
              onPick={(key, instance) => {
                const picked = choiceForModel(choices, key, instance);
                if (!picked) return;
                const account = instance ?? picked.accountId;
                pick({
                  provider: picked.provider,
                  model: picked.modelId,
                  ...(account ? { instance: account } : {}),
                });
              }}
            />
          </PopoverContent>
        </Popover>
      </DaemonSlot>
    </SettingRow>
  );
}
