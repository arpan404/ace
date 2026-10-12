import { useQueryClient } from "@tanstack/react-query";
import { refreshSourceControl } from "@/lib/source-control-cache.ts";
import { useEffect, useState } from "react";
import type { ClientApi } from "@ace/client";
import { useMachines } from "@/lib/machines.ts";
import {
  SourceControlPreferences,
  SettingsValues,
  type Project,
  WorkspaceId,
  type SourceControlReadiness,
} from "@ace/protocol";
import { Select } from "@/components/ui/select.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SettingCard, SettingRow, SettingSection } from "@/components/setting-row.tsx";

export function SourceControlSettings() {
  const machines = useMachines();
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
        <MachineSourceControl key={machine.id} client={machine.client} />
      ) : (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          Connect to this machine to inspect its source control CLI.
        </p>
      )}
    </>
  );
}
function MachineSourceControl({ client }: { client: ClientApi }) {
  const queries = useQueryClient();
  const [status, setStatus] = useState<SourceControlReadiness>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(true);
  const [host, setHost] = useState("github.com");
  const [account, setAccount] = useState("");
  const [remote, setRemote] = useState("origin");
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .request(
        {
          type: "source-control.request",
          operation: {
            op: "readiness",
            ...(workspace ? { workspaceId: WorkspaceId.parse(workspace) } : {}),
          },
        },
        { signal: controller.signal },
      )
      .then((reply) => {
        if (controller.signal.aborted) return;
        if (reply.result.kind !== "readiness")
          throw new Error("Source control status unavailable. Rescan to retry.");
        const next = reply.result.readiness;
        setStatus(next);
        setError(undefined);
        setHost(next.preferences.host);
        setAccount(
          next.preferences.hosts.find((entry) => entry.host === next.preferences.host)?.account ??
            "",
        );
        setRemote(next.preferences.remote);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Source control status unavailable. Rescan to retry.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
    // Rescan deliberately invalidates the machine-local CLI facts after an external login.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, revision, workspace]);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .request(
        { type: "workspace.request", operation: { op: "workspaces.list", limit: 100 } },
        { signal: controller.signal },
      )
      .then((reply) => {
        if (reply.result.kind === "workspaces") setProjects(reply.result.workspaces);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client]);
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
    setPending(true);
    try {
      const reply = await client.request({
        type: "settings.set",
        key: "sourceControl.preferences",
        layer: { kind: "global" },
        value: SettingsValues.shape["sourceControl.preferences"].parse(parsed.data),
      });
      if (!reply.ok) throw new Error("save_failed");
      void refreshSourceControl(queries, client);
      setRevision((value) => value + 1);
    } catch {
      setError("Couldn't save source control preferences. Administrator access is required.");
    } finally {
      setPending(false);
    }
  };
  const disabled = pending;
  return (
    <>
      <SettingSection label="GitHub CLI on this computer">
        <SettingRow
          title="Readiness"
          description={
            status
              ? `${status.cli === "available" ? `gh ${status.version}` : "gh unavailable"} · ${status.preferences.host} · ${status.account ?? "No active account"}`
              : "Checking CLI…"
          }
        >
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              void refreshSourceControl(queries, client);
              setStatus(undefined);
              setPending(true);
              setRevision((value) => value + 1);
            }}
          >
            Rescan
          </Button>
        </SettingRow>
        {status && (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            {status.instructions}
          </p>
        )}
        {status?.accounts.length ? (
          <p className="pb-3 text-sm text-muted-foreground">
            CLI accounts:{" "}
            {status.accounts
              .map((entry) => `${entry.login}${entry.active ? " (active)" : ""}`)
              .join(", ")}
          </p>
        ) : null}
        {error && (
          <p role="alert" className="py-3 text-sm text-destructive">
            {error}
          </p>
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
        <Button className="mt-3" disabled={disabled || !status} onClick={() => void save()}>
          Save preferences
        </Button>
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
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            onValueChange={(value) => {
              setStatus(undefined);
              setPending(true);
              setWorkspace(value);
            }}
            disabled={disabled}
          />
        </SettingRow>
        <p className="py-3 text-sm text-muted-foreground">
          {status?.transportInstructions ??
            "Clone and push use Git's own credential helper or SSH keys on this computer. GitHub API sign-in is separate. Push permission is checked by the push itself."}
        </p>
      </SettingSection>
    </>
  );
}
