import {
  spadeSandboxSentence,
  type SpadeNetworkPolicy,
  type SpadeSecurityMachine,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import {
  SettingCard,
  SettingDisclosure,
  SettingList,
  SettingRow,
  SettingSection,
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

/**
 * Settings › Spade › Security (ADR 0167, 0171): whether this machine seals commands off, said
 * once as the page's first line; then, for commands, where they run and what they may reach, and
 * for plugins what they may reach: the rules every bot inherits. The sites listed by default
 * wait behind their count. Each bot's own rule, folders, grants and checkpoints are in its
 * profile.
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
  const show = (next: SpadeSecurityMachine) => cache.setQueryData(securityMachineKey(key), next);
  const network = (which: SpadeNetworkFor, policy: SpadeNetworkPolicy) => (
    <PolicyRows
      which={which}
      title="What they can reach"
      policy={policy}
      defaults={status.defaults}
      save={async (next) => show(await setMachineNetwork(client, which, next))}
    />
  );
  return (
    <>
      <p className="mb-6 text-ui text-muted-foreground">
        {spadeSandboxSentence(status)} Every bot uses these unless it sets its own.
      </p>
      <SettingSection label="Commands" anchor="commands">
        <CommandsChoice
          title="Where they run"
          value={status.bots.commands}
          effective={status.bots.commands}
          save={async (choice) => {
            if (choice !== "inherit") show(await setMachineCommands(client, choice));
          }}
        />
        {network("commands", status.bots.network)}
      </SettingSection>
      <SettingSection label="Plugins" anchor="plugins">
        {network("plugins", status.bots.pluginNetwork)}
      </SettingSection>
      {status.defaults.length > 0 && (
        <SettingSection label="Sites listed by default" anchor="sites">
          <SettingDisclosure
            title={`${status.defaults.length} ${status.defaults.length === 1 ? "site" : "sites"}`}
          >
            <SettingList aria-label="Sites listed by default">
              {status.defaults.map((host) => (
                <li key={host}>
                  <SettingRow title={host} density="compact" />
                </li>
              ))}
            </SettingList>
          </SettingDisclosure>
        </SettingSection>
      )}
    </>
  );
}
