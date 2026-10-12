import type { ThreadReader, ThreadSource } from "@ace/client";
import type { Interaction, BackgroundTask } from "@ace/protocol";
import { isActionableInteraction } from "@ace/core/human";
import { isRunning } from "./agents.ts";
import { TurnStretches } from "./turn-stretches.ts";
import { rootRunOf } from "./turn-ordinals.ts";
import { ledgerOf } from "./thread-ledger.ts";

type Reader = Pick<
  ThreadReader,
  | "order"
  | "item"
  | "run"
  | "agent"
  | "agentIds"
  | "runIds"
  | "thread"
  | "interactionIds"
  | "interaction"
  | "taskIds"
  | "task"
>;
type Contribution = {
  turn: string | undefined;
  agent: boolean;
  needsYou: boolean;
  request?: Interaction | undefined;
  shell?: BackgroundTask | undefined;
};

/** Canonical unsettled work, indexed by the root run that owns it, including silent children. */
export class TurnTree {
  private readonly entries = new Map<string, Contribution>();
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly links = new Map<string, string | undefined>();
  private readonly watched = new Map<string, Set<string>>();
  private readonly counts = new Map<string, number>();
  private unknown = 0;
  private agents = 0;
  private attention = 0;
  private readonly requests = new Map<string, Interaction>();
  private readonly shells = new Map<string, BackgroundTask>();
  private readonly endOf = new Map<string, { turn: string; at: number }>();
  private readonly ends = new Map<string, Map<string, number>>();
  private readonly stretches = new TurnStretches();
  private rootId: string | undefined;
  private readonly latestEnd = new Map<string, number>();
  private observed = false;
  version = 0;

  private readonly reader: Reader;
  constructor(reader: Reader) {
    this.reader = reader;
    this.reset();
    if ("observe" in reader && typeof reader.observe === "function") {
      this.observed = true;
      const source = reader as Reader & Pick<ThreadSource, "observe">;
      source.observe((keys) => {
        if (keys === "all" || this.rootId !== reader.thread?.rootAgentId) return this.reset();
        const affected = new Set<string>();
        if (keys.has("thread") && this.rootId) affected.add(`agent:${this.rootId}`);
        const ancestryKeys = new Set(keys);
        for (const key of keys) {
          if (!key.startsWith("run:")) continue;
          const id = key.slice(4);
          const run = reader.run(id);
          for (const changed of this.stretches.update(
            id,
            run && run.agentId === this.rootId ? run : undefined,
          ))
            ancestryKeys.add(`run:${changed}`);
        }
        for (const key of ancestryKeys) {
          if (/^(agent|interaction|task|run):/.test(key)) affected.add(key);
          const link = this.link(key);
          const moved = this.links.get(key) !== link;
          if (this.dependencies.has(key)) this.links.set(key, link);
          for (const entry of this.dependencies.get(key) ?? [])
            if (moved || !keys.has(key) || entry.startsWith("interaction:")) affected.add(entry);
        }
        for (const key of affected) this.read(key);
      });
    }
  }

  private reset() {
    this.rootId = this.reader.thread?.rootAgentId;
    this.stretches.reset();
    this.entries.clear();
    this.dependencies.clear();
    this.watched.clear();
    this.links.clear();
    this.counts.clear();
    this.requests.clear();
    this.shells.clear();
    this.endOf.clear();
    this.ends.clear();
    this.latestEnd.clear();
    this.unknown = this.agents = this.attention = 0;
    const runs = this.reader.runIds?.() ?? [];
    for (const id of runs) {
      const run = this.reader.run(id);
      this.stretches.update(id, run && run.agentId === this.rootId ? run : undefined);
    }
    for (const id of runs) this.read(`run:${id}`);
    for (const id of this.reader.agentIds()) this.read(`agent:${id}`);
    for (const id of this.reader.taskIds()) this.read(`task:${id}`);
    for (const id of this.reader.interactionIds()) this.read(`interaction:${id}`);
    this.version++;
  }

  /** Plain readers have no change feed; production sources process only changed entity keys. */
  sync(): this {
    if (!this.observed) {
      const runs = this.reader.runIds?.() ?? [];
      for (const id of runs) {
        const run = this.reader.run(id);
        this.stretches.update(id, run && run.agentId === this.rootId ? run : undefined);
      }
      for (const id of runs) this.read(`run:${id}`);
      for (const id of this.reader.agentIds()) this.read(`agent:${id}`);
      for (const id of this.reader.taskIds()) this.read(`task:${id}`);
      for (const id of this.reader.interactionIds()) this.read(`interaction:${id}`);
    }
    return this;
  }

  /** Status/step deltas do not invalidate historical ancestry whose canonical links are unchanged. */
  private link(key: string): string | undefined {
    const id = key.slice(key.indexOf(":") + 1);
    if (key.startsWith("agent:")) {
      const agent = this.reader.agent(id);
      return agent ? `${agent.parentId ?? ""}\0${agent.spawnedBy ?? ""}` : undefined;
    }
    if (key.startsWith("run:")) {
      const run = this.reader.run(id);
      return run ? `${run.agentId}\0${run.startedAt}\0${run.trigger}` : undefined;
    }
    if (key.startsWith("item:")) return this.reader.item(id)?.runId;
    return undefined;
  }

  private read(key: string) {
    const reader = this.reader;
    const watch = new Set([key]);
    const ancestry = {
      order: reader.order,
      thread: reader.thread,
      item: (id: string) => {
        watch.add(`item:${id}`);
        return reader.item(id);
      },
      agent: (id: string) => {
        watch.add(`agent:${id}`);
        return reader.agent(id);
      },
      run: (id: string) => {
        watch.add(`run:${id}`);
        return reader.run(id);
      },
    };
    const canonical = (id: string | undefined) => {
      const turn = id ? this.turnId(id) : undefined;
      if (turn) watch.add(`run:${turn}`);
      return turn;
    };
    const ownerTurn = (agentId: string, callId?: string, at?: number) => {
      const call = callId ? ancestry.item(callId) : undefined;
      const direct = rootRunOf(ancestry, call?.runId)?.id;
      if (direct) return canonical(direct);
      if (agentId === reader.thread?.rootAgentId) {
        const turn =
          this.entries.get(key)?.turn ??
          this.endOf.get(key)?.turn ??
          (at === undefined ? undefined : this.stretches.at(at)) ??
          reader.thread?.live?.rootRunId ??
          ledgerOf(reader).currentStretch(reader).runId;
        if (turn) watch.add(`run:${turn}`);
        return canonical(turn);
      }
      const owner = ancestry.agent(agentId);
      const spawn = owner?.spawnedBy ? ancestry.item(owner.spawnedBy) : undefined;
      return canonical(rootRunOf(ancestry, spawn?.runId)?.id);
    };
    const id = key.slice(key.indexOf(":") + 1);
    let present = false;
    let next: Contribution | undefined;
    let ended: { turn: string; at: number } | undefined;
    if (key.startsWith("run:")) {
      const run = ancestry.run(id);
      present = !!run;
      this.stretches.update(id, run && run.agentId === this.rootId ? run : undefined);
      const turn = canonical(rootRunOf(ancestry, id)?.id);
      if (run?.state === "active") next = { turn, agent: false, needsYou: false };
      if (run?.endedAt !== undefined && turn) ended = { turn, at: run.endedAt };
    } else if (key.startsWith("agent:")) {
      const agent = ancestry.agent(id);
      present = !!agent;
      if (agent && id !== reader.thread?.rootAgentId && agent.endedAt !== undefined) {
        const turn = ownerTurn(id);
        if (turn) ended = { turn, at: agent.endedAt };
      }
      if (
        agent &&
        id === reader.thread?.rootAgentId &&
        isRunning(agent) &&
        !(
          reader.thread?.imported &&
          reader.thread.status.state === "new" &&
          agent.status.state === "starting"
        )
      ) {
        watch.add("thread");
        const runId = reader.thread?.live?.rootRunId ?? this.stretches.latest();
        if (runId) watch.add(`run:${runId}`);
        next = {
          turn: canonical(runId),
          agent: false,
          needsYou: agent.status.state === "blocked" && agent.status.on === "human",
        };
      }
      if (agent && id !== reader.thread?.rootAgentId && isRunning(agent))
        next = {
          turn: ownerTurn(id),
          agent: true,
          needsYou: agent.status.state === "blocked" && agent.status.on === "human",
        };
    } else if (key.startsWith("task:")) {
      const task = reader.task(id);
      present = !!task;
      if (task?.endedAt !== undefined) {
        const turn = ownerTurn(task.agentId, task.toolCallId, task.startedAt);
        if (turn) ended = { turn, at: task.endedAt };
      }
      if (task && (task.status === "running" || task.status === "unknown"))
        next = {
          turn: ownerTurn(task.agentId, task.toolCallId, task.startedAt),
          agent: false,
          needsYou: false,
          shell: task.kind === "shell" ? task : undefined,
        };
    } else {
      const request = reader.interaction(id);
      present = !!request;
      if (request?.state === "pending")
        next = {
          turn: ownerTurn(request.agentId, request.toolCallId, request.createdAt),
          agent: false,
          needsYou: isActionableInteraction(request, ancestry.agent(request.agentId)?.status),
          request,
        };
    }
    for (const dependency of this.watched.get(key) ?? []) {
      const entries = this.dependencies.get(dependency);
      entries?.delete(key);
      if (!entries?.size) {
        this.dependencies.delete(dependency);
        this.links.delete(dependency);
      }
    }
    if (present) {
      this.watched.set(key, watch);
      for (const dependency of watch)
        if (!this.links.has(dependency)) this.links.set(dependency, this.link(dependency));
      for (const dependency of watch) {
        let entries = this.dependencies.get(dependency);
        if (!entries) this.dependencies.set(dependency, (entries = new Set()));
        entries.add(key);
      }
    } else this.watched.delete(key);
    this.updateEnd(key, ended);
    const previous = this.entries.get(key);
    if (
      previous?.turn === next?.turn &&
      previous?.agent === next?.agent &&
      previous?.needsYou === next?.needsYou &&
      previous?.request === next?.request &&
      previous?.shell === next?.shell
    )
      return;
    if (previous) this.adjust(key, previous, -1);
    if (next) {
      this.entries.set(key, next);
      this.adjust(key, next, 1);
    } else this.entries.delete(key);
    this.version++;
  }

  turnId(runId: string): string {
    return this.stretches.turnId(runId);
  }
  endingRun(runId: string): string {
    return this.stretches.endingRun(runId);
  }

  clock(runId: string): { from: number; idle: number } | undefined {
    return this.stretches.clock(runId);
  }

  private updateEnd(key: string, next: { turn: string; at: number } | undefined) {
    const before = this.endOf.get(key);
    if (before?.turn === next?.turn && before?.at === next?.at) return;
    if (before) {
      const ends = this.ends.get(before.turn);
      ends?.delete(key);
      if (!ends?.size) this.ends.delete(before.turn);
      if (this.latestEnd.get(before.turn) === before.at) {
        this.latestEnd.delete(before.turn);
        for (const at of ends?.values() ?? [])
          this.latestEnd.set(before.turn, Math.max(this.latestEnd.get(before.turn) ?? at, at));
      }
    }
    if (next) {
      this.endOf.set(key, next);
      let ends = this.ends.get(next.turn);
      if (!ends) this.ends.set(next.turn, (ends = new Map()));
      ends.set(key, next.at);
      this.latestEnd.set(next.turn, Math.max(this.latestEnd.get(next.turn) ?? next.at, next.at));
    } else this.endOf.delete(key);
    this.version++;
  }

  endedAt(runId: string): number | undefined {
    return this.latestEnd.get(this.turnId(runId));
  }

  private adjust(key: string, value: Contribution, delta: number) {
    if (value.turn === undefined) this.unknown += delta;
    else {
      const count = (this.counts.get(value.turn) ?? 0) + delta;
      if (count) this.counts.set(value.turn, count);
      else this.counts.delete(value.turn);
    }
    if (value.agent) this.agents += delta;
    if (value.needsYou) this.attention += delta;
    if (value.request) {
      if (delta > 0) this.requests.set(key, value.request);
      else this.requests.delete(key);
    }
    if (value.shell) {
      if (delta > 0) this.shells.set(key, value.shell);
      else this.shells.delete(key);
    }
  }

  settled(runId: string): boolean {
    const turn = this.turnId(runId);
    const run = this.reader.run(this.endingRun(runId));
    return !!run && run.state !== "active" && this.unknown === 0 && !this.counts.has(turn);
  }

  get subagents() {
    return this.agents;
  }
  get backgroundCommands() {
    return this.shells.size;
  }
  get needsYou() {
    return this.attention > 0;
  }
  pending(): readonly Interaction[] {
    return [...this.requests.values()];
  }
  currentCommand(): string | undefined {
    return this.shells.values().next().value?.title;
  }
  watch(): readonly string[] {
    const keys = new Set<string>();
    for (const key of this.entries.keys())
      for (const dependency of this.watched.get(key) ?? []) keys.add(dependency);
    return [...keys];
  }
}

const trees = new WeakMap<Reader, TurnTree>();
export function turnTreeOf(reader: Reader): TurnTree {
  let tree = trees.get(reader);
  if (!tree) trees.set(reader, (tree = new TurnTree(reader)));
  return tree.sync();
}
