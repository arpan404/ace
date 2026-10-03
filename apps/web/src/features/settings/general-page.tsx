import { useQuery } from "@tanstack/react-query";
import type { ProviderKind } from "@ace/protocol";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useProfileName } from "@/lib/profile.ts";
import { settingKeys, type AutoSettle } from "./data/setting-keys.ts";
import { settingsQueries, useSetting, useSettingsBackend } from "./data/use-settings.ts";
import { DaemonSettings } from "./daemon-settings.tsx";
import { SettingSwitch } from "./setting-switch.tsx";

const autoSettleOptions: { value: AutoSettle; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "2d", label: "2 days" },
  { value: "1w", label: "1 week" },
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
        <SettingRow
          title="Default provider for new threads"
          description="You can change it per thread in the composer."
        >
          <DefaultProvider />
        </SettingRow>
        <SettingSwitch
          setting={settingKeys.worktree}
          title="New threads use a worktree"
          description="Keeps your checkout clean. Threads on main are one click away."
        />
        <SettingRow
          title="Auto-settle after"
          description="Threads with no activity move to Settled."
        >
          <Select
            label="Auto-settle after"
            value={autoSettle}
            options={autoSettleOptions}
            onValueChange={(value) => void setAutoSettle(value)}
          />
        </SettingRow>
        <SettingSwitch setting={settingKeys.settleOnMerge} title="Settle when the PR merges" />
        <SettingSwitch setting={settingKeys.openAtLogin} title="Open ace at login" />
      </SettingSection>
      {!fake && <DaemonSettings />}
    </>
  );
}

function DefaultProvider() {
  const backend = useSettingsBackend();
  const providers = useQuery(settingsQueries.providers(backend));
  const [provider, setProvider] = useSetting(settingKeys.defaultProvider);
  const options = (providers.data ?? [])
    .filter((install) => install.version !== null && install.accounts.length > 0)
    .map((install) => ({ value: install.kind, label: install.name }));
  // Keep the stored choice visible even when its CLI is missing, so the page never lies.
  if (!options.some((option) => option.value === provider))
    options.unshift({ value: provider, label: `${provider} (not installed)` });
  return (
    <Select<ProviderKind>
      label="Default provider for new threads"
      value={provider}
      options={options}
      onValueChange={(value) => void setProvider(value)}
      disabled={providers.isPending}
    />
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
