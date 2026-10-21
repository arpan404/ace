import { visibleSessions } from "@ace/ui-core/computer-use";
import { SettingSection } from "@/components/setting-row.tsx";
import { BlockedAppsRow } from "./blocked-apps.tsx";
import { EmulatorWindowRow } from "./emulator-window.tsx";
import { EnableRow, LiveSessions, Permissions } from "./sections.tsx";
import { useComputerUse } from "./use-computer-use.ts";
import { UseMyChromeSettings } from "./use-my-chrome.tsx";

/**
 * Settings › Computer use: on or off, the apps agents can't use, every live session,
 * the screen helper's permissions and how Android emulators open. The daemon decides;
 * this page shows and asks.
 */
export function ComputerUseSettings() {
  const use = useComputerUse();
  const sessions = visibleSessions(use.snapshot.states);
  const active = use.snapshot.enabled || sessions.length > 0;
  return (
    <>
      <SettingSection label="Access">
        <EnableRow use={use} />
        {!use.snapshot.unavailable && <BlockedAppsRow />}
      </SettingSection>
      {active && (
        <SettingSection label="Live sessions">
          <LiveSessions use={use} compact />
        </SettingSection>
      )}
      <SettingSection label="Permissions">
        <Permissions use={use} />
      </SettingSection>
      <SettingSection label="Devices">
        <EmulatorWindowRow />
      </SettingSection>
      <UseMyChromeSettings />
    </>
  );
}
