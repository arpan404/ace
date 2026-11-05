import { SourceControlHosts, gitProviders } from "./source-control-hosts.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { actionErrorText } from "@ace/ui-core";
import {
  SourceControlPreferences,
  SettingsValues,
  type SourceControlReadiness,
  type ForgeRepository,
} from "@ace/protocol";
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
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { useSettingsMachine } from "./machine-scope.tsx";
import { ToolchainSection } from "./toolchain-section.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { SettingSwitch } from "./setting-switch.tsx";

/**
 * Settings › Source control for the machine Settings edits (`SettingsOutlet` renders this page
 * against it): its Git host readiness, the host and account requests use, and a Git transport
 * check per project.
 */
export function SourceControlSettings() {
  const client = useClient();
  const { machine } = useSettingsMachine();
  const machineId = !machine || machine.primary ? "primary" : machine.id;
  return <MachineSourceControl key={machineId} client={client} machineId={machineId} />;
}

/** Why saving failed: admin copy only when the daemon said this device may not. */
function saveFailure(code: string | undefined): string {
  if (code === "forbidden")
    return "Couldn't save source control preferences. Administrator access is required.";
  return `Couldn't save source control preferences. ${actionErrorText(code)}`;
}

function MachineSourceControl({ client, machineId }: { client: ClientApi; machineId: string }) {
  const queries = useQueryClient();
  const preferencesRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [forge, setForge] = useState<ForgeRepository["forge"]>("github");
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
    setForge(
      status.preferences.hosts.find((entry) => entry.host === status.preferences.host)?.forge ??
        "github",
    );
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
    hosts.push({ host, forge, ...(account ? { account } : {}) });
    const parsed = SourceControlPreferences.safeParse({ hosts, host, remote });
    if (!parsed.success) {
      setError("Enter a valid hostname, account and remote name.");
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
  const savedAccount =
    status?.preferences.hosts.find((entry) => entry.host === status.preferences.host)?.account ??
    "";
  const changed =
    !!status &&
    (host !== status.preferences.host ||
      account !== savedAccount ||
      remote !== status.preferences.remote ||
      forge !== (status.preferences.hosts.find((entry) => entry.host === host)?.forge ?? "github"));
  const selected = gitProviders.find((entry) => entry.forge === forge);
  const savedForge =
    status?.preferences.hosts.find((entry) => entry.host === status.preferences.host)?.forge ??
    "github";
  const savedName = gitProviders.find((entry) => entry.forge === savedForge)?.name ?? "GitHub";
  const cliName = savedForge === "gitlab" ? "glab" : savedForge === "origin" ? "origin" : "gh";
  const canCheck = savedForge === "github" || savedForge === "gitlab" || savedForge === "origin";
  const loading = readiness.isFetching && !readiness.isError;
  const disabled = saving || loading;
  const readError = readiness.isError
    ? `Couldn't read source control status. ${actionErrorText(readFailureCode(readiness.error))}`
    : undefined;
  return (
    <>
      <SourceControlHosts
        preferences={status?.preferences}
        disabled={disabled || !status}
        onManage={(provider, target) => {
          setForge(provider);
          setHost(target);
          setAccount(
            status?.preferences.hosts.find((entry) => entry.host === target)?.account ?? "",
          );
          setError(undefined);
          preferencesRef.current?.scrollIntoView?.({ block: "start" });
        }}
      />
      <SettingSection label={savedName}>
        <SettingRow
          title={`${savedName} ${canCheck ? "CLI" : "connection"}`}
          description={
            status && !loading ? (
              `${!canCheck ? "API support pending" : status.cli === "available" ? `${cliName} ${status.version}` : "Not installed"} · ${status.preferences.host}`
            ) : loading ? (
              <Skeleton className="mt-1 w-40" />
            ) : undefined
          }
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => void refreshSourceControl(queries, client)}
          >
            Rescan
          </Button>
        </SettingRow>
        {status && !loading && (
          <SettingRow title={`${savedName} API`} inline>
            <span className="text-sm text-muted-foreground">
              {canCheck ? apiState(status) : "Not available yet"}
            </span>
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
        {(savedForge === "gitlab" || savedForge === "origin") && (
          <SettingNote>
            Pull request details and changed files are available in Code review. Reviews and merge
            actions open on the host.
          </SettingNote>
        )}
        {/* What to do next; when everything is ready the rows above already say so. */}
        {status && !loading && status.api !== "ready" && (
          <SettingNote role="status">{status.instructions}</SettingNote>
        )}
        {(readError ?? error) && (
          <SettingNote role="alert" className="text-destructive">
            {readError ?? error}
          </SettingNote>
        )}
      </SettingSection>
      <div ref={preferencesRef}>
        <SettingSection label="Preferences" scope="daemon">
          <SettingSwitch
            setting={settingKeys.autoDraftCommits}
            entry="generation.autoDraftCommits"
          />
          <SettingRow title="Provider" description="The provider for this host.">
            <Select
              label="Git provider"
              value={forge}
              options={gitProviders.map((entry) => ({ value: entry.forge, label: entry.name }))}
              disabled={disabled}
              onValueChange={(value) => {
                setForge(value);
                setHost(gitProviders.find((entry) => entry.forge === value)?.host ?? "");
                setAccount("");
              }}
            />
          </SettingRow>
          <SettingRow
            title={`${selected?.name ?? "Git"} host`}
            description={
              forge === "github"
                ? "github.com, or a GitHub Enterprise hostname."
                : `The hostname of your ${selected?.name ?? "Git"} installation.`
            }
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
            description="Requests stop if the CLI is signed in as someone else."
            htmlFor="sc-account"
          >
            <Input
              id="sc-account"
              value={account}
              placeholder="Any account"
              onChange={(event) => setAccount(event.target.value)}
              disabled={disabled}
            />
          </SettingRow>
          <SettingRow
            title="Repository remote"
            description="The Git remote that names a project's repository."
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
            <Button size="sm" disabled={disabled || !changed} onClick={() => void save()}>
              Save preferences
            </Button>
          </SettingFooter>
        </SettingSection>
      </div>
      <SettingSection label="Git transport">
        <SettingRow
          title="Check a project's remote"
          description="Reads from the remote; nothing is pushed."
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
            "Clone and push use Git's credential helper or SSH keys on this machine, not the API sign-in."}
        </SettingNote>
      </SettingSection>
      <ToolchainSection label="Tools on this machine" ids={["git"]} />
    </>
  );
}
