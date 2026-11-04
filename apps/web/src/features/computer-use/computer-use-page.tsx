import { visibleSessions } from "@ace/ui-core/computer-use";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { BlockedAppsRow } from "./blocked-apps.tsx";
import { LockedUseRow } from "./locked-use-row.tsx";
import { EnableRow, LiveSessions, Permissions } from "./sections.tsx";
import { useComputerUse } from "./use-computer-use.ts";
import { UseMyChromeSettings } from "./use-my-chrome.tsx";

/**
 * Settings › Computer use: on or off, working while this Mac is locked, the apps agents can't
 * use, every live session, the screen helper's permissions and Use my Chrome. Simulators and
 * emulators are in Settings › Simulators. The daemon decides; this page shows and asks.
 */
export function ComputerUseSettings(props: {
  /** Set when Settings edits another machine: its name. Its screen helper isn't reachable here. */
  remoteMachine?: string | undefined;
}) {
  if (props.remoteMachine) return <RemoteComputerUse name={props.remoteMachine} />;
  return <LocalComputerUse />;
}

/**
 * Another machine's computer use. Its screen helper talks only to a window on that machine, so
 * switching it on and granting system access happen there; its block list and Use my Chrome
 * are its daemon's settings and stay editable from here.
 */
function RemoteComputerUse(props: { name: string }) {
  return (
    <>
      <SettingSection label="Access">
        <SettingRow
          title="Let agents use apps"
          description={`Turned on in ace on ${props.name}, where the system asks for access.`}
        />
        <BlockedAppsRow />
      </SettingSection>
      <UseMyChromeSettings />
    </>
  );
}

function LocalComputerUse() {
  const use = useComputerUse();
  const sessions = visibleSessions(use.snapshot.states);
  const active = use.snapshot.enabled || sessions.length > 0;
  return (
    <>
      <SettingSection label="Access">
        <EnableRow use={use} />
        <LockedUseRow use={use} />
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
      <UseMyChromeSettings />
    </>
  );
}
