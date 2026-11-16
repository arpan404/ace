import { spadeSandboxSentence } from "@ace/ui-core/spade-chat";
import {
  SettingCard,
  SettingList,
  SettingNote,
  SettingRow,
  SettingSection,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { useSecurityMachine } from "./spade-security-api.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";

/**
 * Settings › Spade › Security (ADR 0167): whether this machine seals commands off, the network
 * rule every bot starts with for its commands and its plugins, and the sites listed by default.
 * Each bot's own rule, folders, grants and checkpoints are in its profile.
 */
export function SpadeSecuritySettings() {
  const { line, reading } = useSpadeRunning();
  const machine = useSecurityMachine(line.ready);
  if (!line.ready && !reading)
    return <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />;
  if (machine.isError)
    return (
      <SettingCard>
        <CouldNotRead
          what="the security settings"
          error={machine.error}
          retry={() => void machine.refetch()}
        />
      </SettingCard>
    );
  const status = machine.data;
  if (!status)
    return (
      <SettingCard>
        <LoadingRows label="Spade's security settings" rows={3} />
      </SettingCard>
    );
  return (
    <>
      <div className={settingsGroup}>
        <SettingCard>
          <SettingNote>{spadeSandboxSentence(status)}</SettingNote>
        </SettingCard>
      </div>
      <SettingSection label="Network" anchor="network">
        <SettingRow title="Commands" density="compact" inline>
          <span className="text-ui text-foreground">Listed sites</span>
        </SettingRow>
        <SettingRow title="Plugins" density="compact" inline>
          <span className="text-ui text-foreground">Open</span>
        </SettingRow>
      </SettingSection>
      {status.defaults.length > 0 && (
        <SettingSection label="Sites listed by default" anchor="sites">
          <SettingList aria-label="Sites listed by default">
            {status.defaults.map((host) => (
              <li key={host}>
                <SettingRow title={host} density="compact" />
              </li>
            ))}
          </SettingList>
        </SettingSection>
      )}
    </>
  );
}
