import { stopAllSummary, visibleSessions } from "@ace/ui-core/computer-use";
import { SettingSection } from "@/components/setting-row.tsx";
import { ApprovedApps, EnableRow, LiveSessions, Permissions, StopAllButton } from "./sections.tsx";
import { useComputerUse } from "./use-computer-use.ts";

/**
 * Settings › Computer use: on or off, the global stop, every live session, the apps agents may
 * use and macOS's grants to Ace Screen Helper. The daemon decides; this page shows and asks.
 */
export function ComputerUseSettings() {
  const use = useComputerUse();
  const sessions = visibleSessions(use.snapshot.states);
  const active = use.snapshot.enabled || sessions.length > 0;
  const stopped = !active ? stopAllSummary(use.stopping) : undefined;
  return (
    <>
      <SettingSection label="Access">
        <EnableRow use={use} />
      </SettingSection>
      {active && (
        <>
          <SettingSection
            label="Live sessions"
            actions={sessions.length > 0 ? <StopAllButton use={use} /> : undefined}
          >
            <LiveSessions use={use} compact />
          </SettingSection>
          <SettingSection label="Approved apps">
            <ApprovedApps use={use} />
          </SettingSection>
        </>
      )}
      {stopped && (
        <p
          role={use.stopping.state === "failed" ? "alert" : "status"}
          className={
            use.stopping.state === "failed"
              ? "mt-3 text-sm text-status-failed"
              : "mt-3 text-sm text-muted-foreground"
          }
        >
          {stopped}
        </p>
      )}
      <SettingSection label="macOS permissions">
        <Permissions use={use} />
      </SettingSection>
    </>
  );
}
