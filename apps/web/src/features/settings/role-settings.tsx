import { useConnectionState } from "@ace/client-react";
import type { RunRole, SettingsValues } from "@ace/protocol";
import { roleKeys, runRoles } from "@ace/settings/roles";
import {
  choiceForModel,
  effortLabel,
  pickerModelsFromChoices,
  pickerProviders,
  providerNames,
} from "@ace/ui-core";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { ModelPickerPanel } from "@/features/model-picker/index.ts";
import { useModelChoices, useModelCatalogState } from "@/features/models/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

type Effort = SettingsValues["providers.coder.reasoningEffort"];
const efforts: Effort[] = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];
const effortOptions: SelectOption<Effort>[] = efforts.map((value) => ({
  value,
  label: value === "default" ? "Default effort" : effortLabel(value),
}));
const rows = {
  build: "roles.build",
  judgment: "roles.judgment",
  review: "roles.review",
  verify: "roles.verify",
} as const satisfies Record<RunRole, string>;

/** Settings → Roles: who agents delegate each kind of work to with `runRole`. */
export function RoleSettings() {
  const note = useNotConnectedNote();
  return (
    <SettingSection
      label="Roles"
      anchor="roles"
      card
      scope="daemon"
      note={note}
    >
      {runRoles.map((role) => (
        <RoleRow key={role} role={role} />
      ))}
    </SettingSection>
  );
}

function RoleRow(props: { role: RunRole }) {
  const keys = roleKeys(props.role);
  const row = settingRow(rows[props.role]);
  const [provider, setProvider] = useDaemonSetting(keys.provider);
  const [model, setModel] = useDaemonSetting(keys.model);
  const [effort, setEffort] = useDaemonSetting(keys.effort);
  const write = useSettingWrite(row.title);
  const offline = useConnectionState() !== "ready";
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const statuses = useProviderStatuses();
  const [open, setOpen] = useState(false);
  const models = pickerModelsFromChoices(choices, () => "This account has reached its limit");
  const shown = provider
    ? choices.find((entry) => entry.provider === provider && entry.modelId === model)
    : undefined;
  const label = !provider
    ? "Not set"
    : (shown?.model ?? (model && model !== "default" ? model : providerNames[provider]));
  // The model is written before the provider, so a role is never set with a stale model.
  const pick = (next: { provider: NonNullable<typeof provider>; model: string } | null) => {
    setOpen(false);
    write.run(async () => {
      if (!next) {
        await setProvider(null);
        await setModel("default");
        await setEffort("default");
        return;
      }
      await setModel(next.model);
      await setProvider(next.provider);
    });
  };
  return (
    <SettingRow {...row}>
      <DaemonSlot control={{ loaded: provider !== undefined, offline, pending: write.pending }}>
        <div className="flex items-center gap-2">
          {provider && (
            <Select<Effort>
              label={`${row.title} effort`}
              value={effort ?? "default"}
              options={effortOptions}
              disabled={offline}
              onValueChange={(next) => write.run(() => setEffort(next))}
            />
          )}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={<Button type="button" variant="secondary" size="sm" disabled={offline} />}
              aria-label={`${row.title}: ${label}`}
            >
              {provider && (
                <ProviderAccountIcon provider={provider} size={14} accountLabel={false} />
              )}
              <span className="max-w-48 truncate">{label}</span>
              <CaretDownIcon aria-hidden size={12} className="text-subtle-foreground" />
            </PopoverTrigger>
            <PopoverContent aria-label={row.title} className="overflow-hidden p-0">
              <button
                type="button"
                aria-pressed={!provider}
                className="flex h-8 w-full items-center gap-2 border-b border-border px-3 text-left text-ui hover:bg-accent focus-ring-inset"
                onClick={() => pick(null)}
              >
                <span className="flex-1">Not set</span>
                {!provider && <CheckIcon aria-hidden size={14} />}
              </button>
              <ModelPickerPanel
                models={models}
                providers={pickerProviders(models, statuses.data ?? [])}
                catalog={catalog}
                current={shown?.key}
                currentProvider={provider ?? undefined}
                onPick={(key, instance) => {
                  const picked = choiceForModel(choices, key, instance);
                  if (picked) pick({ provider: picked.provider, model: picked.modelId });
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </DaemonSlot>
    </SettingRow>
  );
}
