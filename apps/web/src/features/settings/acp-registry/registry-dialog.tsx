import { useState } from "react";
import { CommandDialog } from "@/components/ui/command.tsx";
import { useNow } from "@/lib/time.ts";
import { AgentDetail } from "./agent-detail.tsx";
import { ManualAgent } from "./manual-agent.tsx";
import { RegistryList } from "./registry-list.tsx";
import { useRegistry } from "./use-registry.ts";

type View = { kind: "list" } | { kind: "agent"; id: string } | { kind: "manual" };

/**
 * "Add an ACP agent": the official ACP registry, searchable, from the daemon's cache at once
 * and refreshed in the background; an entry's page with its install plan; and, for agents the
 * registry doesn't list, Add by command. `agentId` opens straight on that entry (Update).
 */
export default function AcpRegistryDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  agentId?: string | undefined;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange} title="Add an ACP agent">
      {props.open && <Browser agentId={props.agentId} close={() => props.onOpenChange(false)} />}
    </CommandDialog>
  );
}

/** Mounted only while open, so opening it again revalidates and starts on the list. */
function Browser(props: { agentId: string | undefined; close(): void }) {
  const now = useNow();
  const { list, refresh } = useRegistry(now);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(
    props.agentId ? { kind: "agent", id: props.agentId } : { kind: "list" },
  );
  const agent =
    view.kind === "agent"
      ? list.data?.agents.find((candidate) => candidate.acpAgentId === view.id)
      : undefined;
  const toList = () => setView({ kind: "list" });
  if (view.kind === "manual") return <ManualAgent onBack={toList} onAdded={props.close} />;
  if (agent)
    return (
      <AgentDetail
        key={agent.acpAgentId}
        agent={agent}
        installations={list.data?.installations ?? []}
        onBack={toList}
        onClose={props.close}
      />
    );
  return (
    <RegistryList
      view={list.data}
      loading={list.isPending}
      loadError={list.error?.message}
      refreshing={refresh.isPending}
      refreshFailed={refresh.isError || list.data?.refreshFailed === true}
      now={now}
      query={query}
      onQuery={setQuery}
      onOpen={(entry) => setView({ kind: "agent", id: entry.acpAgentId })}
      onRefresh={() => refresh.mutate()}
      onManual={() => setView({ kind: "manual" })}
    />
  );
}
