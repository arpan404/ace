import type { ProviderKind } from "@ace/protocol";
import { providerChoiceLabel, providerNames } from "@ace/ui-core";
import { useId } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProfileName } from "@/lib/profile.ts";
import { useProviderStatuses, useStartingProvider } from "@/lib/provider-statuses.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { settingKeys, type AutoSettle } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";
import { DaemonSettings } from "./daemon-settings.tsx";
import { RecoverySettings } from "./recovery-settings.tsx";
import { SettingSwitch } from "./setting-switch.tsx";

const autoSettleOptions: { value: AutoSettle; label: string }[] = [
  { value: "1d", label: "After a day" },
  { value: "2d", label: "After 2 days" },
  { value: "1w", label: "After a week" },
  { value: "never", label: "Never" },
];

/**
 * Your name, defaults for new threads, settling, launch at login, and the daemon this window
 * uses. The in-page development daemon is listed under Advanced instead.
 */
export function GeneralSettings() {
  const [autoSettle, setAutoSettle] = useSetting(settingKeys.autoSettle);
  const fake = useDaemonConnection().mode === "fake";
  return (
    <>
      <SettingSection label="You">
        <ProfileNameRow />
      </SettingSection>
      <SettingSection label="Threads">
        <DefaultProvider />
        <SettingSwitch
          setting={settingKeys.worktree}
          title="New threads use a worktree"
          description="Keeps your checkout clean. Threads on main are one click away."
        />
        <SettingRow
          title="Settle done threads"
          description="Done threads with no activity move to Settled. Threads that need you never settle."
        >
          <Select
            label="Settle done threads"
            value={autoSettle}
            options={autoSettleOptions}
            onValueChange={(value) => void setAutoSettle(value)}
          />
        </SettingRow>
        <SettingSwitch setting={settingKeys.settleOnMerge} title="Settle when the PR merges" />
        <OpenAtLogin />
      </SettingSection>
      <RecoverySettings />
      <SettingSection label="Automations">
        <SettingSwitch
          setting={settingKeys.automations}
          title="Run automations"
          description="Scheduled and repository-event automations run on this daemon. Off, none start, not even by hand."
        />
      </SettingSection>
      {!fake && <DaemonSettings />}
    </>
  );
}

/** The desktop app's login item, which it registers itself. A browser has none to offer. */
function OpenAtLogin() {
  const id = useId();
  const { value, update } = useDesktopPreferences();
  if (!value) return null;
  return (
    <SettingRow title="Open ace at login" htmlFor={id}>
      <Switch
        id={id}
        checked={value.openAtLogin}
        onCheckedChange={(on) => void update({ openAtLogin: on })}
      />
    </SettingRow>
  );
}

/**
 * The provider new threads start on. Every CLI discovery found installed is offered, with its
 * state; until the person picks one, the page shows the provider new threads would start on
 * (`useStartingProvider`).
 */
function DefaultProvider() {
  const statuses = useProviderStatuses();
  const start = useStartingProvider();
  const [, setProvider] = useDaemonSetting("providers.default");
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
    <SettingRow title="Default provider for new threads" description={description}>
      {!start.loaded ? (
        <LoadingRegion label="providers">
          <Skeleton className="block h-8 w-36" />
        </LoadingRegion>
      ) : value ? (
        <Select<ProviderKind>
          label="Default provider for new threads"
          value={value}
          options={options}
          onValueChange={(next) => void setProvider(next)}
        />
      ) : (
        <span className="text-ui text-muted-foreground">No provider CLI installed</span>
      )}
    </SettingRow>
  );
}

function ProfileNameRow() {
  const [name, setName] = useProfileName();
  return (
    <SettingRow
      title="Your name"
      description="Its initials mark your account button. Kept on this device."
      htmlFor="profile-name"
    >
      <Input
        id="profile-name"
        className="w-52"
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
