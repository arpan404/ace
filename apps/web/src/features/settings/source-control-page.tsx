import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  actionErrorText,
  defaultForgeHost,
  forgeCanCheck,
  forgeNames,
  forgeOrder,
  hostForge,
  preferencesProblem,
} from "@ace/ui-core";
import { originApiHost, type ForgeKind } from "@ace/protocol/forge";
import {
  SourceControlPreferences,
  SettingsValues,
  type SourceControlReadiness,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { daemonErrorCode } from "@/lib/daemon-command.ts";
import {
  readFailureCode,
  readReadiness,
  refreshSourceControl,
} from "@/lib/source-control-cache.ts";
import { Select } from "@/components/ui/select.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { useSettingsMachine } from "./machine-scope.tsx";
import { SourceControlProjects } from "./source-control-projects.tsx";
import { ToolchainSection } from "./toolchain-section.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { SettingSwitch } from "./setting-switch.tsx";
import { settingRow } from "./settings-index.ts";
import { ForgeIcon } from "@/components/ui/forge-icon.tsx";
import { removeHost, saveHost, showHost } from "./source-control-edits.ts";
import { SourceControlHosts } from "./source-control-hosts.tsx";

/**
 * Settings › Source control for the machine Settings edits (`SettingsOutlet` renders this page
 * against it): its Git hosts with the shown host's readiness, the host and account requests use,
 * and a Git transport check per project.
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
  // The host the form edits: a saved host, or undefined while adding one.
  const [original, setOriginal] = useState<string>();
  const [forge, setForge] = useState<ForgeKind>("github");
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
  const preferences = status?.preferences;
  /** Opens the form on a saved host. */
  const edit = (target: string, from = preferences) => {
    const entry = from?.hosts.find((saved) => saved.host === target);
    setOriginal(target);
    setForge(entry ? hostForge(entry) : "github");
    setHost(target);
    setAccount(entry?.account ?? "");
  };
  // Each fresh reading resets the form to the shown host (adjusted during render).
  const [shown, setShown] = useState<SourceControlReadiness>();
  if (status && status !== shown) {
    setShown(status);
    edit(status.preferences.host, status.preferences);
    setRemote(status.preferences.remote);
  }
  const write = async (next: unknown) => {
    setError(undefined);
    const parsed = SourceControlPreferences.safeParse(next);
    if (!parsed.success) {
      setError(preferencesProblem(parsed.error));
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
  const save = async () => {
    if (!preferences) return;
    const next = saveHost(preferences, original, { forge, host, account }, remote);
    if (!next) {
      setError(`${host} is already a saved host. Manage it from Git hosts.`);
      return;
    }
    await write(next);
  };
  const editing = preferences?.hosts.find((entry) => entry.host === original);
  const changed =
    !!preferences &&
    (!editing ||
      host !== editing.host ||
      forge !== hostForge(editing) ||
      account !== (editing.account ?? "") ||
      remote !== preferences.remote);
  const shownEntry = preferences?.hosts.find((entry) => entry.host === preferences.host);
  const savedForge = shownEntry ? hostForge(shownEntry) : "github";
  const loading = readiness.isFetching && !readiness.isError;
  const disabled = saving || loading;
  const readError = readiness.isError
    ? `Couldn't read source control status. ${actionErrorText(readFailureCode(readiness.error))}`
    : undefined;
  const openForm = () => preferencesRef.current?.scrollIntoView?.({ block: "start" });
  return (
    <>
      <SourceControlHosts
        preferences={preferences}
        shown={{
          status,
          forge: savedForge,
          loading,
          canRescan: forgeCanCheck(savedForge),
          error: readError ?? error,
        }}
        disabled={disabled || !status}
        onAdd={(provider) => {
          const fixed = defaultForgeHost(provider);
          setOriginal(undefined);
          setForge(provider);
          setHost(preferences?.hosts.some((entry) => entry.host === fixed) ? "" : fixed);
          setAccount("");
          setError(undefined);
          openForm();
        }}
        onManage={(target) => {
          edit(target);
          setError(undefined);
          openForm();
        }}
        onShow={(target) => preferences && void write(showHost(preferences, target))}
        onRemove={(target) => {
          const next = preferences && removeHost(preferences, target);
          if (next) void write(next);
        }}
        onRescan={() => void refreshSourceControl(queries, client)}
      />
      <div ref={preferencesRef}>
        <SettingSection label="Preferences" scope="daemon">
          <SettingSwitch
            setting={settingKeys.autoDraftCommits}
            entry="generation.autoDraftCommits"
          />
          <SettingRow {...settingRow("sourceControl.provider")}>
            <Select
              label="Git provider"
              value={forge}
              options={forgeOrder.map((value) => ({
                value,
                label: forgeNames[value],
                icon: <ForgeIcon forge={value} size={14} decorative />,
              }))}
              disabled={disabled}
              onValueChange={(value) => {
                setForge(value);
                setHost(value === "origin" ? originApiHost : defaultForgeHost(value));
                setAccount("");
              }}
            />
          </SettingRow>
          <SettingRow
            {...settingRow("sourceControl.host")}
            title={`${forgeNames[forge]} host`}
            description={
              forge === "github"
                ? "github.com or a GitHub Enterprise hostname"
                : forge === "origin"
                  ? "One hosted service"
                  : "Your installation's hostname"
            }
            htmlFor="sc-host"
          >
            <Input
              id="sc-host"
              value={host}
              onChange={(event) => setHost(event.target.value.toLowerCase())}
              disabled={disabled || forge === "origin"}
            />
          </SettingRow>
          <SettingRow
            {...settingRow("sourceControl.account")}
            description="Requests stop if the CLI is signed in as anyone else"
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
            {...settingRow("sourceControl.remote")}
            description="Names each project's repository"
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
            {original !== preferences?.host && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  if (preferences) edit(preferences.host);
                  setError(undefined);
                }}
              >
                Cancel
              </Button>
            )}
            <Button size="sm" disabled={disabled || !changed} onClick={() => void save()}>
              {original === undefined ? "Add host" : "Save preferences"}
            </Button>
          </SettingFooter>
        </SettingSection>
      </div>
      {/* Project dialogs edit this window's own daemon's projects. */}
      {machineId === "primary" && <SourceControlProjects />}
      <SettingSection label="Git transport">
        <SettingRow title="Check a project's remote" description="Read only; nothing is pushed">
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
