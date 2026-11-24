import {
  spadeSandboxSentence,
  type SpadeNetworkPolicy,
  type SpadeSecurityMachine,
} from "@ace/ui-core/spade-chat";
import { ShieldCheckIcon, ShieldWarningIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { SettingCard, SettingDisclosure, SettingSection } from "@/components/setting-row.tsx";
import { AutonomyChoice } from "./spade-autonomy-choice.tsx";
import { PolicyRows } from "./spade-bot-network.tsx";
import { CommandsChoice } from "./spade-commands-choice.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  securityMachineKey,
  setMachineAutonomy,
  setMachineCommands,
  setMachineNetwork,
  setMachinePermission,
  setNeverApps,
  useSecurityMachine,
  type SpadeNetworkFor,
} from "./spade-security-api.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { NeverApps } from "./spade-never-apps.tsx";
import { PermissionRows } from "./spade-permissions.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";

/**
 * Settings › Spade › Security (ADR 0167, 0171): whether this machine seals commands off, said
 * once as the page's first line; then the Permissions every bot follows unless it sets its own,
 * with the apps bots never use under Computer use (ADR 0171, amendment 7); then how bots decide
 * (ADR 0163, amendment 2); then, for commands, where they run and what they may reach, and
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
  const sealed = status.contained;
  return (
    <>
      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-border-soft bg-surface-1 px-3.5 py-2.5 text-ui text-muted-foreground">
        {sealed ? (
          <ShieldCheckIcon aria-hidden size={16} className="mt-0.5 shrink-0 text-status-ready" />
        ) : (
          <ShieldWarningIcon
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-status-needs-you"
          />
        )}
        <p className="min-w-0 leading-relaxed">
          {spadeSandboxSentence(status)} Every bot uses these unless it sets its own.
        </p>
      </div>
      {status.permissions && (
        <SettingSection label="Permissions" anchor="permissions">
          <PermissionRows
            permissions={status.permissions}
            save={async (which, on) => {
              if (on !== null) show(await setMachinePermission(client, which, on));
            }}
            under={{
              computer_use: (
                <NeverApps
                  apps={status.permissions.neverApps}
                  save={async (apps) => show(await setNeverApps(client, apps))}
                />
              ),
            }}
          />
        </SettingSection>
      )}
      <SettingSection label="Bots" anchor="bots">
        <AutonomyChoice
          title="How they decide"
          value={status.bots.autonomy}
          who="every bot that doesn't set its own"
          confirmed={false}
          save={async (choice) => show(await setMachineAutonomy(client, choice))}
        />
      </SettingSection>
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
            <ul
              data-setting-slot=""
              aria-label="Sites listed by default"
              className="flex flex-wrap gap-1.5 py-2"
            >
              {status.defaults.map((host) => (
                <li
                  key={host}
                  className="rounded-md border border-border-soft bg-secondary/50 px-2.5 py-1 font-mono text-xs text-foreground"
                >
                  {host}
                </li>
              ))}
            </ul>
          </SettingDisclosure>
        </SettingSection>
      )}
    </>
  );
}
