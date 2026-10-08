import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { CaretDownIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useWorkspaceActions, type WorkspaceTab } from "@/lib/workspace/index.ts";
import { ToolbarButton } from "../terminal/toolbar.tsx";
import {
  levelLabels,
  logSources,
  sourceLabels,
  type LevelFilter,
  type LogFilter,
} from "./log-filter.ts";
import { logScopeId, parseLogScope, type LogScope } from "./scopes.ts";

export interface AgentEntry {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
}

const readAgents = (reader: ThreadReader): AgentEntry[] => {
  const root = reader.thread?.rootAgentId;
  const entries = reader.agentIds().flatMap((id) => {
    const agent = reader.agent(id);
    if (!agent) return [];
    const name = id === root ? "Main agent" : (agent.name ?? agent.role ?? "Subagent");
    return [{ id, parentId: agent.parentId, name, depth: 0 }];
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    let depth = 0;
    for (let parent = entry.parentId; parent && depth < 8; depth++)
      parent = byId.get(parent)?.parentId ?? null;
    entry.depth = depth;
  }
  return entries;
};
const sameAgents = (a: readonly AgentEntry[], b: readonly AgentEntry[]) =>
  a.length === b.length &&
  a.every(
    (entry, i) =>
      entry.id === b[i]?.id &&
      entry.name === b[i]?.name &&
      entry.parentId === b[i]?.parentId &&
      entry.depth === b[i]?.depth,
  );
const noAgents: readonly AgentEntry[] = [];

/** The thread's agents with names and nesting depth, for the scope picker. */
export function useThreadAgents(threadId: string): readonly AgentEntry[] {
  const ids = useThread(threadId, ["agents"], (reader) => reader.agentIds(), sameIds);
  const keys = useMemo<ThreadKey[]>(
    () => ["thread", "agents", ...(ids ?? []).map((id): ThreadKey => `agent:${id}`)],
    [ids],
  );
  return useThread(threadId, keys, readAgents, sameAgents) ?? noAgents;
}
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const trigger =
  "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-ui font-medium text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent aria-expanded:bg-accent focus-ring";

/** Thread, one agent (with its subagents) or the daemon: swaps this tab's source in place. */
export function ScopeMenu(props: {
  threadId: string;
  tab: WorkspaceTab;
  agents: readonly AgentEntry[];
}) {
  const { tab, agents } = props;
  const actions = useWorkspaceActions(props.threadId);
  const scope = parseLogScope(tab.id);
  const value = logScopeId(scope) ?? "thread";
  const current =
    scope.kind === "daemon"
      ? "ace"
      : scope.kind === "agent"
        ? (agents.find((agent) => agent.id === scope.agentId)?.name ?? "Agent")
        : "Thread";
  const pick = (next: LogScope) =>
    actions.replace(tab.key, {
      kind: "logs",
      id: logScopeId(next),
      data: tab.data,
      pinned: tab.pinned,
    });
  return (
    <Menu>
      <MenuTrigger aria-label={`Log source: ${current}`} className={trigger}>
        <span className="truncate">{current}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent className="max-h-[min(420px,var(--available-height))] overflow-auto">
        <MenuRadioGroup
          value={value}
          onValueChange={(next: unknown) => {
            if (next === "thread") pick({ kind: "thread" });
            else if (next === "daemon") pick({ kind: "daemon" });
            else if (typeof next === "string") pick(parseLogScope(next));
          }}
        >
          <MenuRadioItem value="thread">Thread</MenuRadioItem>
          {agents.length > 0 && (
            <MenuGroup>
              <MenuLabel>Agents</MenuLabel>
              {agents.map((agent) => (
                <MenuRadioItem
                  key={agent.id}
                  value={logScopeId({ kind: "agent", agentId: agent.id }) ?? agent.id}
                >
                  <span style={{ paddingLeft: Math.min(agent.depth, 4) * 12 }}>{agent.name}</span>
                </MenuRadioItem>
              ))}
            </MenuGroup>
          )}
          <MenuSeparator />
          <MenuRadioItem value="daemon">ace</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Levels and sources: kept with the tab, so the thread's Logs come back filtered the same. */
export function FilterMenus(props: { filter: LogFilter; onChange(next: LogFilter): void }) {
  const { filter } = props;
  const active = filter.level !== "all" || filter.hidden.length > 0;
  return (
    <Menu>
      <MenuTrigger
        render={
          <ToolbarButton
            icon={FunnelSimpleIcon}
            label={active ? "Levels and sources (filtered)" : "Levels and sources"}
            pressed={active}
          />
        }
      />
      <MenuContent align="start" className="min-w-[260px]">
        <MenuGroup>
          <MenuLabel>Level</MenuLabel>
          <MenuRadioGroup
            value={filter.level}
            onValueChange={(next: unknown) => {
              const level = (["all", "warn", "error"] as const).find((each) => each === next);
              if (level) props.onChange({ ...filter, level: level satisfies LevelFilter });
            }}
          >
            {(["all", "warn", "error"] as const).map((level) => (
              <MenuRadioItem key={level} value={level}>
                {levelLabels[level]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuLabel>Sources</MenuLabel>
          {logSources.map((source) => (
            <MenuCheckboxItem
              key={source}
              checked={!filter.hidden.includes(source)}
              closeOnClick={false}
              onCheckedChange={(shown: boolean) =>
                props.onChange({
                  ...filter,
                  hidden: shown
                    ? filter.hidden.filter((each) => each !== source)
                    : [...filter.hidden, source],
                })
              }
            >
              {sourceLabels[source]}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}
