import {
  spadeSandboxSentence,
  type SpadeBotDefaults,
  type SpadeNetworkPolicy,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import {
  SettingCard,
  SettingList,
  SettingNote,
  SettingRow,
  SettingSection,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { PolicyRows } from "./spade-bot-network.tsx";
import { CommandsChoice } from "./spade-commands-choice.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  securityMachineKey,
  setMachineCommands,
  setMachineNetwork,
  useSecurityMachine,
  type SpadeNetworkFor,
} from "./spade-security-api.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";

const networks: [SpadeNetworkFor, string, (bots: SpadeBotDefaults) => SpadeNetworkPolicy][] = [
  ["commands", "Commands", (bots) => bots.network],
  ["plugins", "Plugins", (bots) => bots.pluginNetwork],
];

/**
 * Settings › Spade › Security (ADR 0167, 0171): whether this machine seals commands off, where
 * commands run (in the sandbox or outside it), the network rules every bot inherits for its
 * commands and its plugins, and the sites listed by default.
 * Each bot's own rule, folders, grants and checkpoints are in its profile.
 */
export function SpadeSecuritySettings() {
  const { line, reading } = useSpadeRunning();
  const client = useSpadeClient();
  const key = useSpadeMachine().key;
  const cache = useQueryClient();
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
      <SettingSection label="Commands" anchor="commands">
        <CommandsChoice
          value={status.bots.commands}
          effective={status.bots.commands}
          inheritable={false}
          save={async (choice) => {
            if (choice === "inherit") return;
            cache.setQueryData(securityMachineKey(key), await setMachineCommands(client, choice));
          }}
        />
      </SettingSection>
      <SettingSection label="Network" anchor="network">
        <SettingNote>Bots use these unless they set their own.</SettingNote>
        {networks.map(([which, title, policy]) => (
          <PolicyRows
            key={which}
            which={which}
            title={title}
            policy={policy(status.bots)}
            defaults={status.defaults}
            save={async (next) =>
              cache.setQueryData(
                securityMachineKey(key),
                await setMachineNetwork(client, which, next),
              )
            }
          />
        ))}
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
