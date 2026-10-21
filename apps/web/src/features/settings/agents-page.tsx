import { ProviderReadError, useProviderReadError } from "@/components/provider-read-error.tsx";
import type { ProviderKind } from "@ace/protocol";
import { providerChoiceLabel, providerNames } from "@ace/ui-core";
import { useConnectionState } from "@ace/client-react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProviderStatuses, useStartingProvider } from "@/lib/provider-statuses.ts";
import { AccessDefaultRow } from "./access-default.tsx";
import { settingKeys, type AutoSettle, type SortBy } from "./data/setting-keys.ts";
import { useSettingControl, useSettingWrite } from "./data/use-settings.ts";
import { ProjectFolders } from "./project-folders.tsx";
import { RecoverySettings } from "./recovery-settings.tsx";
import { RoleSettings } from "./role-settings.tsx";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { SettingSwitch } from "./setting-switch.tsx";
import { settingRow } from "./settings-index.ts";
import { GenerationSettings } from "./utility-model.tsx";

const autoSettleOptions: { value: AutoSettle; label: string }[] = [
  { value: "1d", label: "After a day" },
  { value: "2d", label: "After 2 days" },
  { value: "1w", label: "After a week" },
  { value: "never", label: "Never" },
];

const sortByNotes: Record<SortBy, string> = {
  activity: "Threads that need you or are working rise to the top.",
  created: "Threads stay where they started; new ones lead.",
  manual: "Drag threads into your own order; new ones lead.",
};

const sortByOptions: { value: SortBy; label: string }[] = [
  { value: "activity", label: "Live activity" },
  { value: "created", label: "Newest first" },
  { value: "manual", label: "Manual" },
];

/**
 * How agents run on the machine picked in Settings: what new threads start with, what happens
 * while they work and at a usage limit, the roles Offshift hands work to, how the thread list
 * keeps itself tidy, the model behind titles and commit messages, automations and the folders
 * new projects come from. Every device that uses the machine follows these.
 */
export function AgentsSettings() {
  const note = useNotConnectedNote();
  return (
    <>
      <SettingSection label="New threads" card scope="daemon" note={note}>
        <DefaultProvider />
        <AccessDefaultRow />
        <SettingSwitch setting={settingKeys.worktree} entry="threads.useWorktree" />
        <SettingSwitch
          setting={settingKeys.forkOnSwitch}
          entry="threads.forkOnSwitch"
          description="The thread you switch from stays as it was."
        />
      </SettingSection>
      <RecoverySettings />
      <RoleSettings />
      <ThreadListSettings />
      <GenerationSettings />
      <SettingSection label="Automations" card scope="daemon">
        <SettingSwitch setting={settingKeys.automations} entry="automations.enabled" />
      </SettingSection>
      <ProjectFolders />
    </>
  );
}

/** Order and settling: how a list of many threads stays readable. */
function ThreadListSettings() {
  const autoSettle = useSettingControl(
    settingKeys.autoSettle,
    settingRow("threads.autoSettleAfter").title,
  );
  const sortBy = useSettingControl(settingKeys.sortBy, settingRow("threads.sortBy").title);
  return (
    <SettingSection label="Thread list" card scope="daemon">
      <SettingRow {...settingRow("threads.sortBy")} description={sortByNotes[sortBy.value]}>
        <DaemonSlot control={sortBy}>
          <Select
            label="Sort threads"
            value={sortBy.value}
            options={sortByOptions}
            disabled={sortBy.offline}
            onValueChange={sortBy.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow
        {...settingRow("threads.autoSettleAfter")}
        description="Threads that need you never settle."
      >
        <DaemonSlot control={autoSettle}>
          <Select
            label="Settle done threads"
            value={autoSettle.value}
            options={autoSettleOptions}
            disabled={autoSettle.offline}
            onValueChange={autoSettle.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingSwitch setting={settingKeys.settleOnMerge} entry="threads.settleOnMerge" />
      <SettingSwitch setting={settingKeys.settleOnClose} entry="threads.settleOnClose" />
    </SettingSection>
  );
}

/**
 * The provider new threads start on. Every CLI discovery found installed is offered, with its
 * state; until the person picks one, the page shows the provider new threads would start on
 * (`useStartingProvider`).
 */
function DefaultProvider() {
  const statuses = useProviderStatuses();
  const error = useProviderReadError();
  const start = useStartingProvider();
  const row = settingRow("providers.default");
  const [, setProvider] = useDaemonSetting("providers.default");
  const write = useSettingWrite(row.title);
  const offline = useConnectionState() !== "ready";
  const value = start.chosen ?? start.provider;
  const options: SelectOption<ProviderKind>[] = [];
  for (const status of statuses.data ?? [])
    if (status.state !== "not_installed" && !options.some((o) => o.value === status.provider))
      options.push({ value: status.provider, label: providerChoiceLabel(status) });
  // Keep the stored choice visible even when its CLI is missing, so the page never lies.
  if (value && !options.some((option) => option.value === value))
    options.unshift({
      value,
      label: providerChoiceLabel({ name: providerNames[value], state: "not_installed" }),
    });
  return (
    <SettingRow {...row} description="Change it in any thread.">
      {error.providers ? (
        <ProviderReadError message={error.providers} retry={error.retry} />
      ) : (
        <DaemonSlot control={{ loaded: start.loaded, offline, pending: write.pending }}>
          {value ? (
            <Select<ProviderKind>
              label={row.title}
              value={value}
              options={options}
              disabled={offline}
              onValueChange={(next) => write.run(() => setProvider(next))}
            />
          ) : (
            <span className="text-ui text-muted-foreground">No provider CLI installed</span>
          )}
        </DaemonSlot>
      )}
    </SettingRow>
  );
}
