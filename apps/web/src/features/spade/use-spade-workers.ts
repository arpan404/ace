import type { SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { subagentTerminal, type SubagentState } from "@ace/ui-core";
import { listedSubagentState, type SubagentEntry } from "@ace/ui-core/subagent-group";
import {
  spadeTreeWorkers,
  spadeTreeWorkerState,
  type SpadeStartedWorker,
  type SpadeWorkerNode,
} from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLiveList } from "@/lib/live-connection.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { spadeMachineKey, useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { readTree } from "./spade-work-api.ts";

/*
 * What a bot's chat says of the workers it started (ADR 0161), live: an ace agent as ace lists
 * its thread (on the bot's machine), a bot it made as its tree says. The tree is also where an
 * ace agent's state comes from while ace's list doesn't have it; nothing reads done unless one
 * of them says it ended (AGENTS.md priority 1).
 */

/** One worker as its card row shows it, in the shape ace's child rows take. */
export interface SpadeWorkerEntry extends SubagentEntry {
  kind: "ace" | "bot";
  /** A bot worker's own words on what it does now, from the tree. */
  status: string | undefined;
  /** What an ace agent's open request asks for, while it waits on the person. */
  asking: string | undefined;
}

/** The machine the bot runs on, as the window reaches it; undefined while it isn't known. */
export function useBotMachine(): Machine | undefined {
  const scoped = useSpadeMachine();
  const machines = useMachines();
  return machines.find((machine) => spadeMachineKey(machine) === scoped.key);
}

/**
 * The bot's tree, read with Work's key so both share it; again every few seconds while any of
 * the workers may still run (`moving`, read as each read is scheduled).
 */
function useBotTree(bot: string, moving: { current: boolean }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  return useQuery({
    queryKey: ["spade", "work", machine.key, bot, "tree"],
    queryFn: ({ signal }) => readTree(client, bot, signal),
    refetchInterval: () => (moving.current ? 4_000 : false),
    placeholderData: (previous) => previous,
    retry: 1,
  });
}

interface Listed {
  state: SubagentState | undefined;
  provider: ProviderKind | undefined;
  model: string | undefined;
  /** What its oldest open request asks for: `plan_review`, `question`, `approval`. */
  asking: string | undefined;
}

const sameListed = (a: readonly Listed[], b: readonly Listed[]) =>
  a.length === b.length &&
  a.every(
    (one, at) =>
      one.state === b[at]?.state &&
      one.provider === b[at]?.provider &&
      one.model === b[at]?.model &&
      one.asking === b[at]?.asking,
  );

/** Each ace agent as the thread list on the bot's machine has it. */
function useListed(ids: readonly string[]): readonly Listed[] {
  const joined = ids.join("\n");
  const keys = useMemo(
    () =>
      [
        "unconfirmed" as const,
        "sync" as const,
        "error" as const,
        ...joined
          .split("\n")
          .filter(Boolean)
          .map((id) => `thread:${id}` as const),
      ] as const,
    [joined],
  );
  const read = useCallback(
    (reader: SidebarReader): Listed[] =>
      joined
        .split("\n")
        .filter(Boolean)
        .map((id) => {
          const thread = reader.thread(id);
          return {
            state: listedSubagentState(reader, id),
            provider: thread?.execution?.provider ?? thread?.provider,
            model: thread?.execution?.model ?? thread?.live?.model,
            asking: thread?.live?.asking?.[0]?.kind,
          };
        }),
    [joined],
  );
  return useSidebar(keys, read, sameListed) ?? none;
}

const none: readonly never[] = [];

/** A worker's state: ace's list first for an ace agent, else the tree, else still at work. */
function stateOf(
  worker: SpadeStartedWorker,
  listed: Listed | undefined,
  node: SpadeWorkerNode | undefined,
): SubagentState {
  return (
    (worker.kind === "ace" ? listed?.state : undefined) ?? spadeTreeWorkerState(node) ?? "working"
  );
}

/**
 * The rows for `workers` started by bot `bot` at `startedAt`, with whether what they say is
 * current: ace's list on that machine for ace agents, the tree's last answer for bots.
 */
export function useSpadeWorkers(
  bot: string,
  workers: readonly SpadeStartedWorker[],
  startedAt: number,
  /** The bot's machine answers: ace's list there is read. */
  reachable: boolean,
): { entries: SpadeWorkerEntry[]; fresh: boolean } {
  const machine = useBotMachine();
  const remote = machine && !machine.primary ? machine : undefined;
  const aceIds = workers.filter((worker) => worker.kind === "ace").map((worker) => worker.id);
  const listed = useListed(reachable ? aceIds : none);
  const listFresh = useLiveList() && reachable;
  const moving = useRef(true);
  const tree = useBotTree(bot, moving);
  const nodes = useMemo(() => spadeTreeWorkers(tree.data), [tree.data]);
  const entries = workers.map((worker): SpadeWorkerEntry => {
    const own = worker.kind === "ace" ? listed[aceIds.indexOf(worker.id)] : undefined;
    const node = nodes.get(worker.id);
    return {
      id: worker.id,
      kind: worker.kind,
      ...(worker.kind === "ace" ? { childThreadId: worker.id } : {}),
      provider: own?.provider,
      model: own?.model,
      machine: remote?.name,
      machineHost: remote?.id,
      title: worker.name,
      state: stateOf(worker, own, node),
      startedAt,
      status: worker.kind === "bot" ? node?.status : undefined,
      asking: own?.asking,
    };
  });
  // The tree moves while any of them may: read again until every one has ended.
  const unsettled = entries.some((entry) => !subagentTerminal(entry.state));
  useEffect(() => {
    moving.current = unsettled;
  }, [unsettled]);
  const fresh =
    (aceIds.length === 0 || listFresh) &&
    (entries.every((entry) => entry.kind === "ace") || tree.isSuccess);
  return { entries, fresh };
}

/** A message's first line that says something, without its Markdown marks, at most 160 chars. */
export function firstLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")
      .replaceAll(/[*_`]/g, "")
      .trim();
    if (line) return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return undefined;
}
