import { CaretRightIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
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
    <section role="group" aria-label={machine.name} className="mt-10">
      <MachineScope
        machine={machine}
        unavailable={<MachineHeader machine={machine} summary={machineUnavailableText(machine)} />}
      >
        <OnlineMachine machine={machine} />
      </MachineScope>
    </section>
  );
}

/** The machine's group title, as a provider's on Usage: mark, name, and its state at the right. */
function MachineHeader(props: { machine: Machine; summary?: string | undefined }) {
  const { machine } = props;
  const open = useOpenOnMachine();
  const status = machineStatus[machine.status];
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2">
      <h3 className="flex items-center gap-2 text-md font-medium">
        <MachineMark icon={machine.icon} primary={machine.primary} />
        {machine.name}
      </h3>
      <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
        {[status.label, props.summary].filter(Boolean).join(" · ")}
      </p>
      {machine.status === "auth_failed" ? (
        <Button size="sm" variant="secondary" onClick={() => open(machine, "/settings/remote")}>
          Pair again
        </Button>
      ) : (
        machine.client && (
          <Button
            size="sm"
            variant="ghost"
            className="-mr-2.5"
            onClick={() => open(machine, "/settings/agents")}
          >
            Edit settings
          </Button>
        )
      )}
    </div>
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
    <>
      <MachineHeader machine={props.machine} summary={summary} />
      {!entries && !query.isError && (
        <div className="flex flex-col gap-3 py-3">
          <Skeleton className="h-5 w-56 rounded-md" />
          <Skeleton className="h-5 w-44 rounded-md" />
        </div>
      )}
      <div className="flex flex-col pt-1">
        {ordered.map((entry) => (
          <ProviderLine key={entry.id} machine={props.machine} entry={entry} />
        ))}
      </div>
    </>
  );
}

/** One provider on one machine: its state and fix (Sign in, Update…), and the way to its page. */
function ProviderLine(props: { machine: Machine; entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const open = useOpenOnMachine();
  return (
    <div role="group" aria-label={install.name} className="py-1.5">
      <ProviderSetupRow
        provider={install.kind}
        acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
        instance={install.instance}
        name={install.name}
        missing={false}
        view={view}
        updateAvailable={updateAvailable(props.entry)}
        title={
          <span className="inline-flex items-baseline gap-2">
            {install.name}
            <span className="text-xs text-subtle-foreground">
              {row?.version ?? install.version}
            </span>
          </span>
        }
        secondary={
          <span className="ml-auto -mr-1.5">
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
        <Button
          size="sm"
          variant="ghost"
          className="-mr-2.5"
          onClick={() => void navigate({ to: "/settings/remote" })}
        >
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
