import { ProviderReadError, useProviderReadError } from "@/components/provider-read-error.tsx";
import type { ProviderKind } from "@ace/protocol";
import { providerChoiceLabel, providerNames } from "@ace/ui-core";
import { useConnectionState } from "@ace/client-react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProfileName } from "@/lib/profile.ts";
import { useProviderStatuses, useStartingProvider } from "@/lib/provider-statuses.ts";
import { DesktopAppPreferences } from "./desktop-app.tsx";
import { ProjectFolders } from "./project-folders.tsx";
import { AccessDefaultRow } from "./access-default.tsx";
import { settingKeys, type AutoSettle, type SortBy } from "./data/setting-keys.ts";
import { useSettingControl, useSettingWrite } from "./data/use-settings.ts";
import { RecoverySettings } from "./recovery-settings.tsx";
import { RoleSettings } from "./role-settings.tsx";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { SettingSwitch } from "./setting-switch.tsx";
import { TerminalSettings } from "./terminal-settings.tsx";
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
 * This computer's login item, your name, where its terminals open, defaults for new threads,
 * settling, and the daemon this window uses. The in-page development daemon is listed under
 * Advanced instead.
 */
export function GeneralSettings() {
  const autoSettle = useSettingControl(
    settingKeys.autoSettle,
    settingRow("threads.autoSettleAfter").title,
  );
  const sortBy = useSettingControl(settingKeys.sortBy, settingRow("threads.sortBy").title);
  const note = useNotConnectedNote();
  return (
    <>
      <DesktopAppPreferences />
      <SettingSection label="You" card scope="device">
        <ProfileNameRow />
      </SettingSection>
      <TerminalSettings />
      <SettingSection label="Threads" card scope="daemon" note={note}>
        <DefaultProvider />
        <AccessDefaultRow />
        <SettingSwitch
          setting={settingKeys.forkOnSwitch}
          entry="threads.forkOnSwitch"
          description="Preserve this thread and continue on the new provider or account in a separate thread."
        />
        <SettingSwitch
          setting={settingKeys.worktree}
          entry="threads.useWorktree"
          description="Keeps your checkout clean."
        />
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
      <GenerationSettings />
      <RoleSettings />
      <ProjectFolders />
      <RecoverySettings />
      <SettingSection label="Automations" card scope="daemon">
        <SettingSwitch
          setting={settingKeys.automations}
          entry="automations.enabled"
          description="Allows scheduled and manual runs."
        />
      </SettingSection>
    </>
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
  const description = "Change it in any thread.";
  return (
    <SettingRow {...row} description={description}>
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

function ProfileNameRow() {
  const [name, setName] = useProfileName();
  return (
    <SettingRow {...settingRow("profile.name")} description={undefined} htmlFor="profile-name">
      <Input
        id="profile-name"
        className="@[30rem]:w-52"
        defaultValue={name}
        placeholder="Name"
        autoComplete="name"
        maxLength={80}
        onBlur={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setName(event.currentTarget.value);
        }}
      />
    </SettingRow>
  );
}
