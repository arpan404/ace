import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import type { Machine } from "@/lib/machines.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import { MachineScope, machineUnavailableText, useSettingsMachine } from "./machine-scope.tsx";
import { machineStatusWord } from "./machine-status.ts";
import {
  isMissing,
  needsAttention,
  updateAvailable,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";
import type { SettingsPath } from "./settings-pages.ts";

/**
 * Settings › Overview: every machine with its connection and the providers on it that need
 * something (a sign-in, an update, a fix), each with the button that does it; then the devices
 * that reach them. One machine or twenty, the problems are the first thing on the page.
 */
export function OverviewSettings() {
  const { machines } = useSettingsMachine();
  return (
    <>
      <SettingSection label={machines.length > 1 ? "Machines" : "This machine"}>
        {machines.map((machine) => (
          <MachineOverview key={machine.id} machine={machine} />
        ))}
      </SettingSection>
      <DevicesOverview machineCount={machines.length} />
    </>
  );
}

/** Opens a Machine page with `machine` picked in the sidebar. */
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
        unavailable={<MachineHeader machine={machine} summary={machineUnavailableText(machine)} />}
      >
        <OnlineMachine machine={machine} />
      </MachineScope>
    </div>
  );
}

function MachineHeader(props: { machine: Machine; summary?: string | undefined }) {
  const { machine } = props;
  const open = useOpenOnMachine();
  return (
    <SettingRow
      title={
        <span className="inline-flex items-center gap-2">
          <MachineMark icon={machine.icon} primary={machine.primary} />
          {machine.name}
          <span className="text-xs font-normal text-subtle-foreground">
            {machineStatusWord(machine)}
          </span>
        </span>
      }
      description={props.summary}
      inline
    >
      {machine.status === "auth_failed" ? (
        <Button size="sm" variant="secondary" onClick={() => open(machine, "/settings/remote")}>
          Pair again
        </Button>
      ) : (
        machine.client && (
          <Button size="sm" variant="ghost" onClick={() => open(machine, "/settings/agents")}>
            Edit settings
          </Button>
        )
      )}
    </SettingRow>
  );
}

/** A connected machine: how many providers can take work, then each one that needs something. */
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
  return (
    <>
      <MachineHeader machine={props.machine} summary={summary} />
      {!entries && !query.isError && (
        <div className="px-4 py-2">
          <Skeleton className="h-5 w-48 rounded-md" />
        </div>
      )}
      {attention.map((entry) => (
        <AttentionRow key={entry.id} machine={props.machine} entry={entry} />
      ))}
    </>
  );
}

/** One provider that needs something, with the fix (Sign in, Update…) right on the row. */
function AttentionRow(props: { machine: Machine; entry: ProviderEntry }) {
  const { install, view } = props.entry;
  const open = useOpenOnMachine();
  return (
    <div role="group" aria-label={install.name} className="py-2 pl-6">
      <ProviderSetupRow
        provider={install.kind}
        acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
        instance={install.instance}
        name={install.name}
        missing={false}
        view={view}
        updateAvailable={updateAvailable(props.entry)}
        secondary={
          <span className="ml-auto">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => open(props.machine, "/settings/providers", props.entry.id)}
            >
              Open
            </Button>
          </span>
        }
      />
    </div>
  );
}

/** The devices that reach these machines, and the page that manages them. */
function DevicesOverview(props: { machineCount: number }) {
  const backend = useSettingsBackend();
  const devices = useQuery({ ...settingsQueries.devices(backend), retry: false });
  const navigate = useNavigate();
  const count = devices.data?.length;
  const parts = [
    `${props.machineCount} ${props.machineCount === 1 ? "machine" : "machines"}`,
    ...(count === undefined ? [] : [`${count} paired ${count === 1 ? "device" : "devices"}`]),
  ];
  return (
    <SettingSection label="Network">
      <SettingRow title="Machines and devices" description={parts.join(" · ")} inline>
        <Button size="sm" variant="ghost" onClick={() => void navigate({ to: "/settings/remote" })}>
          Manage
        </Button>
      </SettingRow>
    </SettingSection>
  );
}
