import {
  DotsThreeIcon,
  GithubLogoIcon,
  LockSimpleIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { ClientApi } from "@ace/client";
import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { actionErrorText, stepHighlight } from "@ace/ui-core";
import {
  RepositoryListInput,
  type HostedRepository,
  type SourceControlReadiness,
} from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandOption,
  CommandStepList,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  backHint,
  escapeHint,
  KeyHints,
  navigateHint,
  selectHint,
} from "@/components/ui/key-hints.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Select } from "@/components/ui/select.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  readFailureCode,
  readReadiness,
  refreshSourceControl,
  SourceControlReadError,
} from "@/lib/source-control-cache.ts";
import { Notice } from "./folder-notices.tsx";

/**
 * Add project › GitHub repository, as a palette step: one search box over the repositories the
 * machine's logged-in GitHub CLI can see, the other filters behind ⋯, ↑ ↓ through the list and
 * Enter (or a click) to clone the highlighted one.
 */
export function GithubStep(props: {
  machine: Machine;
  onBack: (() => void) | undefined;
  onSelect(repository: HostedRepository): void;
  trailing?: ReactNode;
}) {
  const batch = useNotifyBatch();
  const client = props.machine.client;
  if (!client)
    return (
      <>
        <CommandStepRow onBack={props.onBack}>
          <span className="flex-1 text-ui text-muted-foreground">GitHub repository</span>
          {props.trailing}
        </CommandStepRow>
        <Notice icon={WifiSlashIcon}>{props.machine.name} isn't connected.</Notice>
      </>
    );
  // Reads go to the chosen machine and wait for its own connection.
  return (
    <ClientProvider client={client} batch={batch}>
      <RepositoryBrowser
        key={props.machine.id}
        client={client}
        machineId={props.machine.id}
        {...props}
      />
    </ClientProvider>
  );
}

function RepositoryBrowser(props: {
  client: ClientApi;
  machineId: string;
  onBack: (() => void) | undefined;
  onSelect(repository: HostedRepository): void;
  trailing?: ReactNode;
}) {
  const [selection, setSelection] = useState<{ host: string; account: string }>();
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<RepositoryListInput["visibility"]>("all");
  const [archived, setArchived] = useState<RepositoryListInput["archived"]>("no");
  const [fork, setFork] = useState<RepositoryListInput["fork"]>("all");
  const [active, setActive] = useState<number | undefined>(0);
  const listId = useId();
  const queries = useQueryClient();
  const status = useDaemonQuery({
    queryKey: ["projects", "github-readiness", props.machineId],
    read: (client, signal) => readReadiness(client, undefined, signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnReconnect: "always",
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
  const repositories = useDaemonQuery({
    queryKey: [
      "projects",
      "github-repositories",
      props.machineId,
      host,
      account,
      owner,
      query,
      visibility,
      archived,
      fork,
    ],
    read: async (client, signal) => {
      if (!input.success) throw new SourceControlReadError("git_invalid_argument");
      const reply = await client.request(
        { type: "repositories.request", operation: { op: "list", input: input.data } },
        { signal },
      );
      if (reply.result.kind === "error") throw new SourceControlReadError(reply.result.code);
      if (reply.result.kind !== "repositories")
        throw new SourceControlReadError("forge_invalid_data");
      return reply.result.repositories;
    },
    refetchOnReconnect: "always",
    enabled: readiness?.api === "ready" && input.success,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const rows = repositories.data ?? [];
  const current = active !== undefined && active < rows.length ? active : undefined;
  const highlighted = current === undefined ? undefined : rows[current];
  useEffect(() => {
    if (current !== undefined)
      document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);
  const error = status.error
    ? `Couldn't read GitHub CLI readiness. ${actionErrorText(readFailureCode(status.error))}`
    : repositories.error
      ? `Couldn't list repositories. ${actionErrorText(readFailureCode(repositories.error))}`
      : readiness && readiness.api !== "ready"
        ? readiness.instructions
        : readiness && !input.success
          ? "Enter a valid host, CLI account and optional repository owner."
          : undefined;
  const loading =
    !error &&
    (status.isPending || (input.success && readiness?.api === "ready" && !repositories.data));

  let state: ReactNode = null;
  if (error) state = <Notice icon={LockSimpleIcon}>{error}</Notice>;
  else if (loading) state = <ListSkeleton label="repositories" shape="row" rows={6} />;
  else if (!rows.length) state = <Notice icon={GithubLogoIcon}>No repositories match.</Notice>;

  return (
    <>
      <CommandStepRow onBack={props.onBack}>
        <input
          role="combobox"
          aria-label="Search GitHub repositories"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted ? `${listId}-${current}` : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={query}
          placeholder="Search repositories"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (
              stepFieldKey(event, {
                text: query,
                onBack: props.onBack,
                onClear: () => setQuery(""),
              })
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp")
              setActive(stepHighlight(current, event.key === "ArrowDown" ? 1 : -1, rows.length));
            else if (event.key === "Enter" && highlighted) props.onSelect(highlighted);
            else return;
            event.preventDefault();
          }}
          className={commandStepField}
        />
        <Popover>
          <PopoverTrigger
            render={<IconButton icon={DotsThreeIcon} label="Repository filters" size="sm" />}
          />
          <PopoverContent
            align="end"
            aria-label="Repository filters"
            className="grid w-72 gap-2 p-3"
          >
            {readiness && (
              <Select
                label="GitHub host"
                value={host}
                options={readiness.preferences.hosts.map((entry) => ({
                  value: entry.host,
                  label: entry.host,
                }))}
                onValueChange={(value) =>
                  setSelection({
                    host: value,
                    account:
                      readiness.preferences.hosts.find((entry) => entry.host === value)?.account ??
                      "",
                  })
                }
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
              placeholder="Owner (all)"
              onChange={(event) => setOwner(event.target.value)}
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
            <Button
              variant="secondary"
              disabled={status.isFetching || repositories.isFetching}
              onClick={() => void refreshSourceControl(queries, props.client)}
            >
              Rescan
            </Button>
          </PopoverContent>
        </Popover>
        {props.trailing}
      </CommandStepRow>
      {state ?? (
        <CommandStepList id={listId} label="GitHub repositories" className="h-[min(320px,46dvh)]">
          {rows.map((row, at) => (
            <CommandOption
              key={row.id}
              id={`${listId}-${at}`}
              active={at === current}
              label={`${row.repository.owner}/${row.repository.name}`}
              onPoint={() => setActive(at)}
              onPick={() => props.onSelect(row)}
            >
              <Icon icon={row.visibility === "private" ? LockSimpleIcon : GithubLogoIcon} />
              <span className="min-w-0 shrink-0 truncate">
                {row.repository.owner}/{row.repository.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {[row.archived && "archived", row.fork && "fork", row.description]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </CommandOption>
          ))}
        </CommandStepList>
      )}
      <KeyHints
        hints={[
          ...(rows.length ? [navigateHint, selectHint] : []),
          ...(props.onBack ? [backHint] : []),
          escapeHint(query),
        ]}
      />
    </>
  );
}
