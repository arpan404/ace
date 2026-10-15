import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ClientApi } from "@ace/client";
import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { actionErrorText } from "@ace/ui-core";
import {
  SourceControlPreferences,
  SettingsValues,
  type SourceControlReadiness,
} from "@ace/protocol";
import { useMachines } from "@/lib/machines.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { daemonErrorCode } from "@/lib/daemon-command.ts";
import {
  apiState,
  readFailureCode,
  readReadiness,
  refreshSourceControl,
} from "@/lib/source-control-cache.ts";
import { Select } from "@/components/ui/select.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  SettingCard,
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";

export function SourceControlSettings() {
  const machines = useMachines();
  const batch = useNotifyBatch();
  const [chosen, setChosen] = useState<{ id: string; primary: boolean }>();
  const machine = chosen
    ? machines.find((entry) => entry.id === chosen.id || (chosen.primary && entry.primary))
    : machines[0];
  return (
    <>
      <SettingCard className="mt-7">
        <SettingRow
          title="Machine"
          description="Readiness and preferences belong to the selected daemon."
        >
          <Select
            label="Source control machine"
            value={machine?.id ?? chosen?.id ?? ""}
            options={[
              ...machines.map((entry) => ({
                value: entry.id,
                label: `${entry.name}${entry.status !== "online" ? " (offline)" : ""}`,
              })),
              ...(!machine && chosen ? [{ value: chosen.id, label: "Unavailable machine" }] : []),
            ]}
            onValueChange={(id) => {
              const next = machines.find((entry) => entry.id === id);
              if (next) setChosen({ id: next.id, primary: next.primary });
            }}
          />
        </SettingRow>
      </SettingCard>
      {machine?.client ? (
        // Reads go to the selected daemon, gated on its own connection.
        <ClientProvider client={machine.client} batch={batch}>
          {/* The primary machine keeps its key while its host identity loads, so edits survive. */}
          <MachineSourceControl
            key={machine.primary ? "primary" : machine.id}
            client={machine.client}
            machineId={machine.primary ? "primary" : machine.id}
          />
        </ClientProvider>
      ) : (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          Connect to this machine to inspect its source control CLI.
        </p>
      )}
    </>
  );
}

/** Why saving failed: admin copy only when the daemon said this device may not. */
function saveFailure(code: string | undefined): string {
  if (code === "forbidden")
    return "Couldn't save source control preferences. Administrator access is required.";
  return `Couldn't save source control preferences. ${actionErrorText(code)}`;
}

function MachineSourceControl({ client, machineId }: { client: ClientApi; machineId: string }) {
  const queries = useQueryClient();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [host, setHost] = useState("github.com");
  const [account, setAccount] = useState("");
  const [remote, setRemote] = useState("origin");
  const [workspace, setWorkspace] = useState("");
  const readiness = useDaemonQuery({
    queryKey: ["projects", "github-readiness", "settings", machineId, workspace],
    retry: false,
    staleTime: 0,
    refetchOnReconnect: "always",
    read: (reader, signal) => readReadiness(reader, workspace || undefined, signal),
  });
  const projects = useDaemonQuery({
    queryKey: ["projects", "source-control-list", machineId],
    retry: false,
    refetchOnReconnect: "always",
    read: async (reader, signal) => {
      const reply = await reader.request(
        { type: "workspace.request", operation: { op: "workspaces.list", limit: 100 } },
        { signal },
      );
      if (reply.result.kind !== "workspaces") throw new Error("unavailable");
      return reply.result.workspaces;
    },
  });
  const status: SourceControlReadiness | undefined = readiness.data;
  // Each fresh reading resets the form to what the daemon holds (adjusted during render).
  const [shown, setShown] = useState<SourceControlReadiness>();
  if (status && status !== shown) {
    setShown(status);
    setHost(status.preferences.host);
    setAccount(
      status.preferences.hosts.find((entry) => entry.host === status.preferences.host)?.account ??
        "",
    );
    setRemote(status.preferences.remote);
  }
  const save = async () => {
    if (!status) return;
    setError(undefined);
    const hosts = status.preferences.hosts.filter((entry) => entry.host !== host);
    hosts.push({ host, ...(account ? { account } : {}) });
    const parsed = SourceControlPreferences.safeParse({ hosts, host, remote });
    if (!parsed.success) {
      setError("Enter a valid hostname, GitHub login and remote name.");
      return;
    }
    setSaving(true);
    try {
      const reply = await client.request({
        type: "settings.set",
        key: "sourceControl.preferences",
        layer: { kind: "global" },
        value: SettingsValues.shape["sourceControl.preferences"].parse(parsed.data),
      });
      if (!reply.ok) {
        const reason = reply.diagnostics[0]?.message;
        setError(
          reason
            ? `Couldn't save source control preferences. ${reason}`
            : saveFailure("action_failed"),
        );
        return;
      }
      await refreshSourceControl(queries, client);
    } catch (failure) {
      const code = daemonErrorCode(failure);
      setError(saveFailure(code === "unknown" ? undefined : code));
    } finally {
      setSaving(false);
    }
  };
  const loading = readiness.isFetching && !readiness.isError;
  const disabled = saving || loading;
  const readError = readiness.isError
    ? `Couldn't read source control status. ${actionErrorText(readFailureCode(readiness.error))}`
    : undefined;
  return (
    <>
      <SettingSection label="GitHub CLI on this computer">
        <SettingRow
          title="Readiness"
          description={
            status && !loading ? (
              `${status.cli === "available" ? `gh ${status.version}` : "gh unavailable"} · ${status.preferences.host}`
            ) : loading ? (
              <Skeleton className="mt-1 w-40" />
            ) : undefined
          }
        >
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => void refreshSourceControl(queries, client)}
          >
            Rescan
          </Button>
        </SettingRow>
        {status && !loading && (
          <SettingRow title="GitHub API" inline>
            <span className="text-sm text-muted-foreground">{apiState(status)}</span>
          </SettingRow>
        )}
        {status?.accounts.length && !loading ? (
          <SettingRow title="CLI accounts" inline>
            <span className="text-sm text-muted-foreground">
              {status.accounts
                .map((entry) => `${entry.login}${entry.active ? " (active)" : ""}`)
                .join(", ")}
            </span>
          </SettingRow>
        ) : null}
        {status && !loading && <SettingNote role="status">{status.instructions}</SettingNote>}
        {(readError ?? error) && (
          <SettingNote role="alert" className="text-destructive">
            {readError ?? error}
          </SettingNote>
        )}
      </SettingSection>
      <SettingSection label="Host and expected account" scope="daemon">
        <SettingRow
          title="GitHub host"
          description="Add an explicit GitHub Enterprise hostname, or use github.com."
          htmlFor="sc-host"
        >
          <Input
            id="sc-host"
            value={host}
            onChange={(event) => setHost(event.target.value.toLowerCase())}
            disabled={disabled}
          />
        </SettingRow>
        <SettingRow
          title="Expected account"
          description="Optional GitHub login. Requests stop if the CLI uses another account. Switch accounts in your own CLI, then Rescan."
          htmlFor="sc-account"
        >
          <Input
            id="sc-account"
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            disabled={disabled}
          />
        </SettingRow>
        <SettingRow
          title="Repository remote"
          description="Choose the Git remote used to identify repositories, such as origin or upstream."
          htmlFor="sc-remote"
        >
          <Input
            id="sc-remote"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            disabled={disabled}
          />
        </SettingRow>
        <SettingFooter>
          <Button disabled={disabled || !status} onClick={() => void save()}>
            Save preferences
          </Button>
        </SettingFooter>
      </SettingSection>
      <SettingSection label="Git transport">
        <SettingRow
          title="Check project remote"
          description="A read checks Git transport access without pushing."
        >
          <Select
            label="Project transport check"
            value={workspace}
            options={[
              { value: "", label: "Choose a project" },
              ...(projects.data ?? []).map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
            onValueChange={setWorkspace}
            disabled={disabled || !projects.data}
          />
        </SettingRow>
        {projects.isError && (
          <SettingNote role="alert" className="text-destructive">
            {`Couldn't list projects. ${actionErrorText(readFailureCode(projects.error))}`}{" "}
            <Button variant="ghost" size="sm" onClick={() => void projects.refetch()}>
              Retry
            </Button>
          </SettingNote>
        )}
        <SettingNote>
          {status?.transportInstructions ??
            "Clone and push use Git's own credential helper or SSH keys on this computer. GitHub API sign-in is separate. Push permission is checked by the push itself."}
        </SettingNote>
      </SettingSection>
    </>
  );
}
