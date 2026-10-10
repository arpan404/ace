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
import { PermissionDefaults } from "@/components/permission-defaults.tsx";
import { settingKeys, type AutoSettle } from "./data/setting-keys.ts";
import { useSettingControl, useSettingWrite } from "./data/use-settings.ts";
import { RecoverySettings } from "./recovery-settings.tsx";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { SettingSwitch } from "./setting-switch.tsx";

const autoSettleOptions: { value: AutoSettle; label: string }[] = [
  { value: "1d", label: "After a day" },
  { value: "2d", label: "After 2 days" },
  { value: "1w", label: "After a week" },
  { value: "never", label: "Never" },
];

/**
 * This computer's login item, your name, defaults for new threads, settling, and the daemon this
 * window uses. The in-page development daemon is listed under Advanced instead.
 */
export function GeneralSettings() {
  const autoSettle = useSettingControl(
    settingKeys.autoSettle,
    settingRow("threads.autoSettleAfter").title,
  );
  const note = useNotConnectedNote();
  return (
    <>
      <DesktopAppPreferences />
      <SettingSection label="You" card scope="device">
        <ProfileNameRow />
      </SettingSection>
      <SettingSection label="Threads" card scope="daemon" note={note}>
        <DefaultProvider />
        <SettingSwitch
          setting={settingKeys.worktree}
          entry="threads.useWorktree"
          description="Keeps your checkout clean. Threads on main are one click away."
        />
        <SettingRow
          {...settingRow("threads.autoSettleAfter")}
          description="Done threads with no activity move to Settled. Threads that need you never settle."
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
      <SettingSection label="Default permissions" anchor="permissions.providerModes" scope="daemon">
        <PermissionDefaults />
      </SettingSection>
      <ProjectFolders />
      <RecoverySettings />
      <SettingSection label="Automations" card scope="daemon">
        <SettingSwitch
          setting={settingKeys.automations}
          entry="automations.enabled"
          description="Turn off to stop new automation runs, including manual runs."
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
  const description = start.chosen
    ? "You can change it per thread in the composer."
    : "Until you pick one, new threads start on the provider you used last, else the first one installed. You can change it per thread in the composer.";
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
    <SettingRow
      {...settingRow("profile.name")}
      description="Its initials mark your account button."
      htmlFor="profile-name"
    >
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
