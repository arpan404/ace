import { GithubLogoIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { ClientApi } from "@ace/client";
import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { actionErrorText } from "@ace/ui-core";
import {
  RepositoryListInput,
  type HostedRepository,
  type SourceControlReadiness,
} from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandOption,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { fieldHints, KeyHints, navigateHint, selectHint } from "@/components/ui/key-hints.tsx";
import {
  ListStatus,
  ListViewport,
  OptionSkeletons,
  optionGeometry,
} from "@/components/ui/list-viewport.tsx";
import { useListHighlight } from "@/components/ui/use-list-highlight.ts";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import type { Machine } from "@/lib/machines.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  readFailureCode,
  readReadiness,
  refreshSourceControl,
  SourceControlReadError,
} from "@/lib/source-control-cache.ts";
import { activeFilters, defaultFilters, onlyTypedChanged } from "./repository-filters.ts";
import { RepositoryFiltersMenu } from "./repository-filters-menu.tsx";

const viewport = "h-[min(320px,46dvh)]";

/** A text button after a status line. */
const action = (label: string, run: () => void) => (
  <Button size="sm" variant="ghost" onClick={run}>
    {label}
  </Button>
);
/** Where the typed parts (account, owner, search text) sit in the list's query key. */
const typedAt = [4, 5, 6];
/** How long a step left keeps its reads, so Back to it shows them at once and asks again. */
const keptMs = 30_000;

/**
 * Add project › GitHub repository, as a palette step: one search box over the repositories the
 * machine's logged-in GitHub CLI can see, the other filters behind ⋯, ↑ ↓ through the list and
 * Enter (or a click) to clone the highlighted one. The search goes out once typing settles; the
 * last answer stays, dimmed and out of reach, until the new one comes. A failure says why beside
 * what fixes it (Retry, Check again), and an empty answer names the filters narrowing it.
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
        <ListViewport className={viewport}>
          <ListStatus>{props.machine.name} isn't connected.</ListStatus>
        </ListViewport>
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
  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState("");
  const settled = useDebouncedValue(query, searchSettleMs);
  const queries = useQueryClient();
  const status = useDaemonQuery({
    queryKey: ["projects", "github-readiness", props.machineId],
    read: (client, signal) => readReadiness(client, undefined, signal),
    retry: false,
    gcTime: keptMs,
    staleTime: 0,
    refetchOnReconnect: "always",
  });
  const readiness: SourceControlReadiness | undefined = status.data;
  // The account and owner are typed: they ask once typing settles, as the search text does.
  const chosen = useDebouncedValue(selection, searchSettleMs);
  const owner = useDebouncedValue(filters.owner, searchSettleMs);
  const host = chosen?.host ?? readiness?.preferences.host ?? "";
  const account = chosen?.account ?? readiness?.account ?? "";
  const { visibility, archived, fork } = filters;
  const input = RepositoryListInput.safeParse({
    host,
    account,
    ...(owner ? { owner } : {}),
    query: settled,
    visibility,
    archived,
    fork,
  });
  const key = [
    "projects",
    "github-repositories",
    props.machineId,
    host,
    account,
    owner,
    settled,
    visibility,
    archived,
    fork,
  ];
  const repositories = useDaemonQuery({
    queryKey: key,
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
    // Only typing keeps the last answer up; another host or a chosen filter is another list.
    placeholderData: (previous, previousQuery) =>
      previousQuery && onlyTypedChanged(previousQuery.queryKey, key, typedAt)
        ? previous
        : undefined,
    refetchOnReconnect: "always",
    enabled: readiness?.api === "ready" && input.success,
    retry: false,
    gcTime: keptMs,
    staleTime: 0,
  });
  const rows = repositories.data ?? [];
  // The last answer, showing while the one for what's typed now comes.
  const stale =
    repositories.isPlaceholderData ||
    query !== settled ||
    selection !== chosen ||
    filters.owner !== owner;
  // The best match is highlighted from the start, so Enter clones it.
  const list = useListHighlight({ count: rows.length, start: 0 });
  const { listId, current } = list;
  const rescan = () => void refreshSourceControl(queries, props.client);
  const narrowed = activeFilters(filters, selection?.account);
  const clearFilters = () => {
    setFilters(defaultFilters);
    setSelection(undefined);
  };

  let state: ReactNode = null;
  if (status.error)
    state = (
      <ListStatus actions={action("Retry", () => void status.refetch())}>
        Couldn't read GitHub CLI readiness. {actionErrorText(readFailureCode(status.error))}
      </ListStatus>
    );
  else if (readiness && readiness.api !== "ready")
    state = (
      <ListStatus actions={action("Check again", rescan)}>{readiness.instructions}</ListStatus>
    );
  else if (readiness && !input.success)
    state = (
      <ListStatus actions={action("Clear filters", clearFilters)}>
        Enter a valid host, CLI account and optional repository owner.
      </ListStatus>
    );
  else if (repositories.error)
    state = (
      <ListStatus
        actions={
          <>
            {action("Retry", () => void repositories.refetch())}
            {narrowed.length > 0 && action("Clear filters", clearFilters)}
          </>
        }
      >
        Couldn't list repositories. {actionErrorText(readFailureCode(repositories.error))}
      </ListStatus>
    );
  else if (status.isPending || (input.success && !repositories.data))
    state = <OptionSkeletons label="repositories" rows={6} geometry={optionGeometry} />;
  else if (!rows.length && !stale)
    state = (
      <ListStatus actions={narrowed.length > 0 && action("Clear filters", clearFilters)}>
        {settled ? `No repositories match “${settled}”` : "No repositories here"}
        {narrowed.length > 0 ? ` with ${narrowed.join(", ")}.` : "."}
      </ListStatus>
    );

  return (
    <>
      <CommandStepRow onBack={props.onBack}>
        <input
          role="combobox"
          aria-label="Search GitHub repositories"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-busy={stale || undefined}
          aria-activedescendant={current === undefined ? undefined : list.optionId(current)}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={query}
          placeholder="Search repositories"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            list.reset(0);
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
            const picked = list.key(event, () => !stale);
            if (picked.kind === "pass" && event.key === "Enter") event.preventDefault();
            if (picked.kind !== "pick") return;
            event.preventDefault();
            const row = rows[picked.at];
            if (row) props.onSelect(row);
          }}
          className={commandStepField}
        />
        <RepositoryFiltersMenu
          readiness={readiness}
          host={selection?.host ?? readiness?.preferences.host ?? ""}
          account={selection?.account ?? readiness?.account ?? ""}
          onAccount={setSelection}
          filters={filters}
          onFilters={setFilters}
          rescanning={status.isFetching || repositories.isFetching}
          onRescan={rescan}
        />
        {props.trailing}
      </CommandStepRow>
      <ListViewport className={viewport}>
        {state}
        <div
          id={listId}
          role="listbox"
          aria-label="GitHub repositories"
          hidden={state !== null}
          className={stale ? "opacity-60 transition-opacity" : undefined}
        >
          {rows.map((row, at) => (
            <CommandOption
              key={row.id}
              id={list.optionId(at)}
              active={at === current}
              disabled={stale}
              label={`${row.repository.owner}/${row.repository.name}`}
              onPoint={() => list.point(at)}
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
        </div>
      </ListViewport>
      <KeyHints
        hints={[
          ...(rows.length ? [navigateHint] : []),
          ...(rows.length && !stale ? [selectHint] : []),
          ...fieldHints(query, props.onBack),
        ]}
      />
    </>
  );
}
