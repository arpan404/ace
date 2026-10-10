import { visibleSessions } from "@ace/ui-core/computer-use";
import { SettingSection } from "@/components/setting-row.tsx";
import { ApprovedApps, EnableRow, LiveSessions, Permissions, StopAllButton } from "./sections.tsx";
import { useComputerUse } from "./use-computer-use.ts";

/**
 * Settings › Computer use: on or off, the global stop, every live session, the apps agents may
 * use and macOS's grants to Ace Screen Helper. The daemon decides; this page shows and asks.
 */
export function ComputerUseSettings() {
  const use = useComputerUse();
  return (
    <>
      <SettingSection label="Access">
        <EnableRow use={use} />
      </SettingSection>
      {(use.snapshot.enabled || visibleSessions(use.snapshot.states).length > 0) && (
        <>
          <SettingSection
            label="Live sessions"
            actions={
              visibleSessions(use.snapshot.states).length > 0 ? (
                <StopAllButton use={use} />
              ) : undefined
            }
          >
            <LiveSessions use={use} compact />
          </SettingSection>
          <SettingSection label="Approved apps">
            <ApprovedApps use={use} />
          </SettingSection>
        </>
      )}
      <SettingSection label="macOS permissions">
        <Permissions use={use} />
      </SettingSection>
    </>
  );
}
