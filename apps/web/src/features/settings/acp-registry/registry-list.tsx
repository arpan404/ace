import type { RegistryAgent } from "@ace/protocol";
import { CheckIcon } from "@phosphor-icons/react";
import {
  registryAge,
  registryPublisher,
  registryStanding,
  searchRegistry,
  type RegistryStanding,
} from "@ace/ui-core/acp-registry";
import { useQuery } from "@tanstack/react-query";
import { acpRegistryId } from "@ace/ui-core/provider-icons";
import { settingsQueries, useSettingsBackend } from "../data/use-settings.ts";
import { useMemo } from "react";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { cn } from "@/lib/cn.ts";
import { AgentIcon } from "./agent-icon.tsx";
import type { RegistryView } from "./registry-data.ts";

interface Row {
  agent: RegistryAgent;
  standing: RegistryStanding;
}

/**
 * The registry as a palette: type to filter by name, publisher or description, ↑/↓ and Enter
 * to open an entry. Rows are one line: mark, name, publisher, what it is, version and, only
 * when it matters, installed or not available here. What can't install here sorts last.
 */
export function RegistryList(props: {
  view: RegistryView | undefined;
  loading: boolean;
  loadError: string | undefined;
  refreshing: boolean;
  refreshFailed: boolean;
  now: number;
  query: string;
  onQuery(query: string): void;
  onOpen(agent: RegistryAgent): void;
  onRefresh(): void;
  onManual(): void;
}) {
  const { view, query } = props;
  const phone = usePhone();
  const providers = useQuery(settingsQueries.providers(useSettingsBackend()));
  const added = new Set(
    (providers.data ?? [])
      .filter((provider) => provider.state !== "not_installed")
      .map((provider) => acpRegistryId(provider.acpAgentId ?? provider.kind)),
  );
  const groups = useMemo(() => {
    const rows = searchRegistry(view?.agents ?? [], query).map((agent): Row => ({
      agent,
      standing: registryStanding(agent, view?.installations ?? []),
    }));
    const items = [
      ...rows.filter((row) => row.standing.kind !== "unavailable"),
      ...rows.filter((row) => row.standing.kind === "unavailable"),
    ];
    return [{ value: "ACP registry", items }];
  }, [view, query]);
  const empty = !view || view.agents.length === 0;
  return (
    <Command
      items={groups}
      itemToStringValue={(row: Row) => row.agent.name}
      filter={null}
      value={query}
      onValueChange={props.onQuery}
    >
      <CommandInput
        aria-label="Search the ACP registry"
        placeholder={phone ? "Search agents" : "Search agents by name, publisher or what they do…"}
        closeLabel="Close"
      />
      <CommandEmpty>
        {props.loading ? (
          "Reading the registry…"
        ) : empty && props.refreshing ? (
          <span className="inline-flex items-center gap-2">
            <Spinner label="Downloading the registry" /> Downloading the registry…
          </span>
        ) : empty ? (
          <span role="alert">
            {props.loadError ??
              (props.refreshFailed
                ? "Couldn't reach the ACP registry. Check the connection."
                : "The registry is empty.")}{" "}
            <Button variant="link" onClick={props.onRefresh}>
              Try again
            </Button>
          </span>
        ) : (
          <>
            No agents match “{query.trim()}”.{" "}
            <Button variant="link" onClick={props.onManual}>
              Add one by command
            </Button>
          </>
        )}
      </CommandEmpty>
      <CommandList aria-label="ACP agents">
        {(group: { value: string; items: Row[] }) => (
          <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel className="sr-only">{group.value}</CommandGroupLabel>
            <CommandCollection>
              {(row: Row) => (
                <CommandItem
                  key={row.agent.acpAgentId}
                  value={row}
                  onClick={() => props.onOpen(row.agent)}
                >
                  <AgentIcon agent={row.agent} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-muted-foreground",
                      row.standing.kind === "unavailable" && "opacity-60",
                    )}
                  >
                    <span className="text-foreground">{row.agent.name}</span>
                    {!phone && (
                      <span className="ml-1.5 text-sm">{registryPublisher(row.agent.authors)}</span>
                    )}
                    <span className="ml-1.5 text-sm text-subtle-foreground">
                      {row.agent.description}
                    </span>
                  </span>
                  {!phone && (
                    <span className="shrink-0 font-mono text-xs text-subtle-foreground">
                      {row.agent.version}
                    </span>
                  )}
                  {added.has(acpRegistryId(row.agent.acpAgentId)) &&
                  row.standing.kind !== "installed" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Already added</span>
                  ) : (
                    <Standing standing={row.standing} phone={phone} />
                  )}
                </CommandItem>
              )}
            </CommandCollection>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex shrink-0 items-center gap-3.5 border-t px-3.5 py-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {props.refreshing ? (
            <>
              <Spinner label="Updating the registry" /> Updating…
            </>
          ) : (
            <>
              <span className="truncate">
                {props.refreshFailed && !empty
                  ? "Couldn't reach the registry · Showing the saved list"
                  : registryAge(view?.fetchedAt, props.now)}
              </span>
              ·
              <Button variant="link" size="sm" onClick={props.onRefresh}>
                Refresh
              </Button>
            </>
          )}
        </span>
        <Button
          variant="link"
          size="sm"
          className="ml-auto text-muted-foreground"
          onClick={props.onManual}
        >
          Add by command
        </Button>
      </div>
    </Command>
  );
}

/** Installed (or behind), or why it can't install here; nothing when it can. */
function Standing(props: { standing: RegistryStanding; phone: boolean }) {
  const { standing } = props;
  if (standing.kind === "available") return null;
  if (standing.kind === "unavailable")
    return (
      <span className="shrink-0 text-xs text-subtle-foreground">
        {props.phone ? "Unavailable" : standing.reason}
      </span>
    );
  if (standing.update)
    return (
      <span className="shrink-0 text-xs text-status-needs-you">
        {props.phone ? "Update" : "Update available"}
      </span>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon aria-hidden weight="bold" />
      Installed
    </span>
  );
}
