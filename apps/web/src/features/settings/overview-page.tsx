import { CaretRightIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import type { Machine } from "@/lib/machines.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { settingsQueries, useSetting, useSettingsBackend } from "./data/use-settings.ts";
import { MachineScope, machineUnavailableText, useSettingsMachine } from "./machine-scope.tsx";
import {
  isMissing,
  needsAttention,
  updateAvailable,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";
import type { SettingsPath } from "./settings-pages.ts";

const transports = {
  local: "This computer only",
  lan: "Local network",
  tailscale: "Tailscale",
  relay: "Relay",
};

/**
 * Settings › Overview, the fleet at a glance, laid out as Usage lays out accounts: one group per
 * machine, headed by its mark and name with its connection at the right, and under it every
 * provider on it, those that need something first, each with the button that fixes it. Then how
 * other devices reach this machine. One machine or twenty, the problems come first.
 */
export function OverviewSettings() {
  const { machines } = useSettingsMachine();
  return (
    <>
      {machines.map((machine) => (
        <MachineOverview key={machine.primary ? "primary" : machine.id} machine={machine} />
      ))}
      <NetworkOverview machineCount={machines.length} />
    </>
  );
}

/** Opens a Machine page with `machine` picked. */
function useOpenOnMachine() {
  const { choose } = useSettingsMachine();
  const navigate = useNavigate();
  return (machine: Machine, to: SettingsPath, provider?: string) => {
    choose(machine.primary ? undefined : machine.id);
    if (provider) void navigate({ to: "/settings/providers/$provider", params: { provider } });
    else void navigate({ to });
  };
}

function MachineOverview(props: { machine: Machine }) {
  const { machine } = props;
  return (
    <div role="group" aria-label={machine.name}>
      <MachineScope
        machine={machine}
        unavailable={
          <MachineSection machine={machine} summary={machineUnavailableText(machine)}>
            <SettingNote>{machineUnavailableText(machine)}</SettingNote>
          </MachineSection>
        }
      >
        <OnlineMachine machine={machine} />
      </MachineScope>
    </div>
  );
}

/**
 * One machine as a settings group: its name over a card, its connection and readiness at the
 * label's right with the way into its settings, then its rows.
 */
function MachineSection(props: {
  machine: Machine;
  summary?: string | undefined;
  children: ReactNode;
}) {
  const { machine } = props;
  const open = useOpenOnMachine();
  const status = machineStatus[machine.status];
  return (
    <SettingSection
      label={machine.name}
      actions={
        <>
          <span>
            {[status.label, machine.client ? props.summary : undefined].filter(Boolean).join(" · ")}
          </span>
          {machine.status === "auth_failed" ? (
            <Button size="sm" variant="ghost" onClick={() => open(machine, "/settings/remote")}>
              Pair again
            </Button>
          ) : (
            machine.client && (
              <Button size="sm" variant="ghost" onClick={() => open(machine, "/settings/agents")}>
                Edit settings
              </Button>
            )
          )}
        </>
      }
    >
      {props.children}
    </SettingSection>
  );
}

/** A connected machine: how many providers can take work, then each provider, problems first. */
function OnlineMachine(props: { machine: Machine }) {
  const { entries, query } = useProviderEntries();
  const installed = entries?.filter((entry) => !isMissing(entry)) ?? [];
  const attention = installed.filter(needsAttention);
  const ready = installed.filter((entry) => entry.view?.ready).length;
  const summary = query.isError
    ? "Couldn't check its providers."
    : !entries
      ? undefined
      : !installed.length
        ? "No coding agents installed"
        : attention.length
          ? `${ready} of ${installed.length} providers ready`
          : `All ${installed.length} providers ready`;
  const ordered = [...attention, ...installed.filter((entry) => !needsAttention(entry))];
  return (
    <MachineSection machine={props.machine} summary={summary}>
      {!entries && !query.isError ? (
        <div className="flex min-h-(--setting-row-height) items-center px-3.5" data-setting-slot="">
          <Skeleton className="h-4 w-48 rounded-md" />
        </div>
      ) : query.isError ? (
        <SettingNote>Couldn't check its providers.</SettingNote>
      ) : !installed.length ? (
        <SettingNote>No coding agents installed.</SettingNote>
      ) : (
        ordered.map((entry) => (
          <ProviderLine key={entry.id} machine={props.machine} entry={entry} />
        ))
      )}
    </MachineSection>
  );
}

/** One provider on one machine: its state and fix (Sign in, Update…), and the way to its page. */
function ProviderLine(props: { machine: Machine; entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const open = useOpenOnMachine();
  return (
    <div role="group" aria-label={install.name} data-setting-slot="" className="px-3.5 py-1.5">
      <ProviderSetupRow
        provider={install.kind}
        acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
        instance={install.instance}
        name={install.name}
        missing={false}
        view={view}
        updateAvailable={updateAvailable(props.entry)}
        title={
          <button
            type="button"
            className="inline-flex items-baseline gap-2 rounded-xs text-left focus-ring hover:underline"
            onClick={() => open(props.machine, "/settings/providers", props.entry.id)}
          >
            {install.name}
            <span className="text-xs text-subtle-foreground">
              {row?.version ?? install.version}
            </span>
          </button>
        }
        secondary={
          // Narrow, the name opens the page and the arrow would only wrap onto its own line.
          <span className="ml-auto -mr-1.5 hidden @[34rem]:inline-flex">
            <IconButton
              icon={CaretRightIcon}
              size="sm"
              label={`Open ${install.name} on ${props.machine.name}`}
              onClick={() => open(props.machine, "/settings/providers", props.entry.id)}
            />
          </span>
        }
      />
    </div>
  );
}

/** How other devices reach this machine, and the page that manages them. */
function NetworkOverview(props: { machineCount: number }) {
  const backend = useSettingsBackend();
  const devices = useQuery({ ...settingsQueries.devices(backend), retry: false });
  const [remote] = useSetting(settingKeys.remoteEnabled);
  const [transport] = useSetting(settingKeys.remoteTransport);
  const navigate = useNavigate();
  const count = devices.data?.length;
  return (
    <SettingSection
      label="Network"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void navigate({ to: "/settings/remote" })}>
          Manage
        </Button>
      }
    >
      <SettingRow title="Remote access" inline>
        <span className="text-ui text-muted-foreground">
          {remote ? `On · ${transports[transport]}` : "Off"}
        </span>
      </SettingRow>
      <SettingRow title="Machines" inline>
        <span className="text-ui tabular-nums text-muted-foreground">{props.machineCount}</span>
      </SettingRow>
      <SettingRow title="Paired devices" inline>
        <span className="text-ui tabular-nums text-muted-foreground">{count ?? "–"}</span>
      </SettingRow>
    </SettingSection>
  );
}
