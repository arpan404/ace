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
        <div className="flex h-9 items-center gap-3 border-b">
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            Stops every session at once, releases every agent and turns computer use off until you
            turn it on again.
          </p>
          <StopAllButton use={use} />
        </div>
      </SettingSection>
      <SettingSection label="Live sessions">
        <LiveSessions use={use} compact />
      </SettingSection>
      <SettingSection label="Approved apps">
        <ApprovedApps use={use} />
      </SettingSection>
      <SettingSection label="macOS permissions">
        <Permissions use={use} />
      </SettingSection>
    </>
  );
}
