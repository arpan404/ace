import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ClientApi } from "@ace/client";
import {
  RepositoryListInput,
  type HostedRepository,
  type SourceControlReadiness,
} from "@ace/protocol";
import type { Machine } from "@/lib/machines.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Problem } from "./form-parts.tsx";

export function HostedRepositoriesTab(props: {
  machine: Machine;
  onSelect(repository: HostedRepository): void;
}) {
  return props.machine.client ? (
    <RepositoryBrowser
      key={props.machine.id}
      client={props.machine.client}
      machineId={props.machine.id}
      onSelect={props.onSelect}
    />
  ) : null;
}
function RepositoryBrowser(props: {
  client: ClientApi;
  machineId: string;
  onSelect(repository: HostedRepository): void;
}) {
  const [selection, setSelection] = useState<{ host: string; account: string }>();
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<RepositoryListInput["visibility"]>("all");
  const [archived, setArchived] = useState<RepositoryListInput["archived"]>("no");
  const [fork, setFork] = useState<RepositoryListInput["fork"]>("all");
  const [revision, setRevision] = useState(0);
  const status = useQuery({
    meta: { daemonClient: props.client },
    queryKey: ["projects", "github-readiness", props.machineId, revision],
    queryFn: async ({ signal }) => {
      const reply = await props.client.request(
        { type: "source-control.request", operation: { op: "readiness" } },
        { signal },
      );
      if (reply.result.kind !== "readiness") throw new Error("unavailable");
      return reply.result.readiness;
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const readiness: SourceControlReadiness | undefined = status.data;
  const host = selection?.host ?? readiness?.preferences.host ?? "";
  const account = selection?.account ?? readiness?.account ?? "";
  const input = RepositoryListInput.safeParse({
    host,
    account,
    ...(owner ? { owner } : {}),
    query,
    visibility,
    archived,
    fork,
  });
  const repositories = useQuery({
    meta: { daemonClient: props.client },
    queryKey: [
      "projects",
      "github-repositories",
      props.machineId,
      revision,
      host,
      account,
      owner,
      query,
      visibility,
      archived,
      fork,
    ],
    queryFn: async ({ signal }) => {
      if (!input.success) throw new Error("invalid_filters");
      const reply = await props.client.request(
        { type: "repositories.request", operation: { op: "list", input: input.data } },
        { signal },
      );
      if (reply.result.kind !== "repositories") throw new Error("unavailable");
      return reply.result.repositories;
    },
    enabled: readiness?.api === "ready" && input.success,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const rows = repositories.data;
  const error = status.error
    ? "Couldn't inspect GitHub CLI readiness. Rescan to retry."
    : repositories.error
      ? "Repository access failed. Check the selected host/account in Source control settings, organization access and network, then Rescan."
      : undefined;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Browse repositories accessible to this computer's GitHub CLI. Selecting one opens the clone
        destination and progress flow.
      </p>
      <div className="flex flex-wrap gap-2">
        {readiness && (
          <Select
            label="GitHub host"
            value={host}
            options={readiness.preferences.hosts.map((entry) => ({
              value: entry.host,
              label: entry.host,
            }))}
            onValueChange={(value) => {
              setSelection({
                host: value,
                account:
                  readiness.preferences.hosts.find((entry) => entry.host === value)?.account ?? "",
              });
            }}
          />
        )}
        <Input
          aria-label="GitHub account"
          value={account}
          placeholder="CLI account"
          onChange={(event) => setSelection({ host, account: event.target.value })}
        />
        <Input
          aria-label="Repository owner"
          value={owner}
          placeholder="Account or organization (all)"
          onChange={(event) => setOwner(event.target.value)}
        />
        <Input
          aria-label="Search GitHub repositories"
          value={query}
          placeholder="Search name or description"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select<RepositoryListInput["visibility"]>
          label="Repository visibility"
          value={visibility}
          options={[
            { value: "all", label: "All visibility" },
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
          onValueChange={setVisibility}
        />
        <Select<RepositoryListInput["archived"]>
          label="Archived repositories"
          value={archived}
          options={[
            { value: "all", label: "All archive states" },
            { value: "no", label: "Active" },
            { value: "yes", label: "Archived" },
          ]}
          onValueChange={setArchived}
        />
        <Select<RepositoryListInput["fork"]>
          label="Fork repositories"
          value={fork}
          options={[
            { value: "all", label: "Include forks" },
            { value: "no", label: "Exclude forks" },
            { value: "yes", label: "Forks only" },
          ]}
          onValueChange={setFork}
        />
        <Button onClick={() => setRevision((value) => value + 1)}>Rescan</Button>
      </div>
      {readiness?.api !== "ready" && readiness && (
        <Problem>
          {readiness.instructions} Open Settings → Source control to configure this computer.
        </Problem>
      )}
      {error && <Problem>{error}</Problem>}
      {readiness?.api === "ready" && !input.success && (
        <Problem>Enter a valid host, CLI account and optional repository owner.</Problem>
      )}
      {!rows && input.success && readiness?.api === "ready" && !error && (
        <p role="status">Loading repositories…</p>
      )}
      {rows?.length === 0 && <p role="status">No repositories match these filters.</p>}
      <ul className="grid max-h-64 gap-1 overflow-y-auto" aria-label="GitHub repositories">
        {rows?.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="grid w-full gap-1 rounded-md p-3 text-left hover:bg-accent focus-ring"
              onClick={() => props.onSelect(row)}
            >
              <span className="text-ui font-medium">
                {row.repository.owner}/{row.repository.name} · {row.visibility}
                {row.archived ? " · archived" : ""}
                {row.fork ? " · fork" : ""}
              </span>
              <span className="text-sm text-muted-foreground">{row.description}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        API access and Git clone permission are separate. Clone uses this computer's Git credential
        helper / SSH keys.
      </p>
    </div>
  );
}
