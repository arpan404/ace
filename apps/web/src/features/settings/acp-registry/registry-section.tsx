import type { RegistryAgent } from "@ace/protocol";
import {
  registryAge,
  registryPublisher,
  registryStanding,
  searchRegistry,
} from "@ace/ui-core/acp-registry";
import { acpRegistryId } from "@ace/ui-core/provider-icons";
import { useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { SettingAction, SettingNote } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { ListRowFrame, ProviderListRow } from "@/features/provider-setup/index.ts";
import { useNow } from "@/lib/time.ts";
import { AddAgentByCommandRow } from "../add-acp-agent.tsx";
import { isMissing, type ProviderEntry } from "../provider-entries.ts";
import { ProvidersGroup } from "../providers-group.tsx";
import { useRegistry } from "./use-registry.ts";

/** How many agents show before Show all. */
const firstRows = 5;

interface AgentHubRow {
  agent: RegistryAgent;
  /** Why it can't install on this computer, if it can't. */
  unavailable: string | undefined;
}

/**
 * Settings → Providers → ACP agents: what ace can install here. Built-in providers not yet on
 * this computer first, then the official ACP registry (agents already added are in Installed),
 * searchable by name, publisher or description; the first few, then Show all. The last row adds
 * an agent the registry doesn't list, by command.
 */
export function AcpAgents(props: { entries: readonly ProviderEntry[] }) {
  const now = useNow();
  const { list, refresh } = useRegistry(now);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const view = list.data;
  // Agents ace already knows as a provider: added ones are in Installed, built-in ones missing
  // here have their own row above.
  const known = new Set(
    props.entries.map((entry) => acpRegistryId(entry.install.acpAgentId ?? entry.install.kind)),
  );
  const terms = query.trim().toLowerCase();
  // A row shows here until its provider is installed; then it is in Installed, and only there.
  const providers = props.entries
    .filter((entry) => isMissing(entry))
    .filter((entry) => !terms || entry.install.name.toLowerCase().includes(terms));
  const agents = searchRegistry(view?.agents ?? [], query)
    .filter(
      (agent) =>
        !known.has(acpRegistryId(agent.acpAgentId)) &&
        registryStanding(agent, view?.installations ?? []).kind !== "installed",
    )
    .map((agent): AgentHubRow => {
      const standing = registryStanding(agent, view?.installations ?? []);
      return { agent, unavailable: standing.kind === "unavailable" ? standing.reason : undefined };
    });
  // What can't install here sorts last.
  const rows = [
    ...agents.filter((row) => !row.unavailable),
    ...agents.filter((row) => row.unavailable),
  ];
  const folded = !terms && !all && rows.length > firstRows;
  const shown = folded ? rows.slice(0, firstRows) : rows;
  const empty = !view || view.agents.length === 0;
  const failed = refresh.isError || view?.refreshFailed === true;
  const source = refresh.isPending
    ? "updating…"
    : failed && !empty
      ? "couldn't reach it, showing the saved list"
      : lowerFirst(registryAge(view?.fetchedAt, now));
  return (
    <ProvidersGroup
      label="ACP agents"
      aside={
        <>
          From the ACP registry · {source}
          {!refresh.isPending && !empty && (
            <>
              {" · "}
              <button
                type="button"
                className="rounded-xs text-muted-foreground hover:text-foreground focus-ring"
                onClick={() => refresh.mutate()}
              >
                Refresh
              </button>
            </>
          )}
        </>
      }
      actions={
        <SearchField
          label="Search agents"
          placeholder="Search agents"
          value={query}
          onValueChange={setQuery}
          className="h-7 w-36 sm:w-56"
        />
      }
    >
      {providers.map((entry) => (
        <BuiltInRow key={entry.id} entry={entry} />
      ))}
      {list.isPending ? (
        <ListSkeleton label="the registry" shape="row" rows={3} className="py-3" />
      ) : empty && refresh.isPending ? (
        <SettingNote className="inline-flex items-center gap-2">
          <Spinner label="Downloading the registry" /> Downloading the registry…
        </SettingNote>
      ) : empty && !terms ? (
        <SettingNote role="alert">
          {list.error?.message ??
            (failed
              ? "Couldn't reach the ACP registry. Check the connection."
              : "The registry is empty.")}{" "}
          <Button size="sm" variant="ghost" onClick={() => refresh.mutate()}>
            Retry
          </Button>
        </SettingNote>
      ) : (
        <>
          {shown.map((row) => (
            <AgentRow key={row.agent.acpAgentId} agent={row.agent} unavailable={row.unavailable} />
          ))}
          {terms && !shown.length && !providers.length && (
            <SettingNote>No agents match “{query.trim()}”.</SettingNote>
          )}
          {!terms && agents.length > firstRows && (
            <SettingAction aria-expanded={!folded} onClick={() => setAll(!all)}>
              {folded ? `Show all ${agents.length} agents` : "Show fewer"}
            </SettingAction>
          )}
        </>
      )}
      <AddAgentByCommandRow />
    </ProvidersGroup>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A built-in provider not on this computer yet: Install, and its page explains it. */
function BuiltInRow(props: { entry: ProviderEntry }) {
  const { install, view } = props.entry;
  const agent = install.registry?.agent;
  return (
    <ProviderListRow
      provider={install.kind}
      acpAgentId={agent?.acpAgentId ?? install.acpAgentId}
      instance={install.instance}
      name={install.name}
      missing
      readiness={view}
      page={props.entry.id}
      version={agent?.version}
      sub={agent ? registryPublisher(agent.authors) || agent.description : undefined}
    />
  );
}

/** A registry agent: Install, or why it can't install on this computer. */
function AgentRow(props: { agent: RegistryAgent; unavailable: string | undefined }) {
  const { agent } = props;
  const sub = registryPublisher(agent.authors) || agent.description;
  if (props.unavailable)
    return (
      <ListRowFrame
        provider="acp"
        acpAgentId={agent.acpAgentId}
        name={agent.name}
        version={agent.version}
        sub={sub}
        right={<span className="text-xs text-muted-foreground">{props.unavailable}</span>}
      />
    );
  return (
    <ProviderListRow
      provider="acp"
      acpAgentId={agent.acpAgentId}
      name={agent.name}
      missing
      version={agent.version}
      sub={sub}
      setUp={`acp:${agent.acpAgentId}`}
    />
  );
}
