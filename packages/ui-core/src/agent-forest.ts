import type { Agent, BackgroundTask, Interaction, ThreadStatus } from "@ace/protocol";
import { agentRuns } from "./agent-runs.ts";
import { agentTreeWork } from "./agents.ts";

/*
 * The agent tree across threads (ADR 0108). A thread's agents form a tree by `parentId`; an
 * agent whose work is a delegated thread of its own (`childThreadId`) carries that thread's tree
 * under it, and so on down. Each thread's facts come from its own subscription; this module only
 * joins them. Pure: no clocks, no I/O.
 */

/** One thread's live entities, as a subscription reads them. */
export interface ThreadWork {
  agents: readonly Agent[];
  tasks: readonly BackgroundTask[];
  /** Pending requests only. */
  interactions: readonly Interaction[];
  status?: ThreadStatus | undefined;
  /**
   * How current these facts are. `live` (the default) once the daemon confirmed them; `syncing`
   * while a reconnect catches up or a kept copy waits for confirmation, so a thread shown done
   * may be working again; `not_loaded` when there was no room for it or its subscription failed,
   * so it has no entities and its delegate stands alone.
   */
  facts?: "live" | "syncing" | "not_loaded" | undefined;
}

/** What a branch holds below its row, at any depth. */
export interface ForestTally {
  /** Agents still working or waiting. */
  working: number;
  /** Agents whose whole branch settled, as the daemon confirmed. */
  done: number;
  /** Settled-looking agents whose branch isn't confirmed or loaded yet: maybe working again. */
  syncing: number;
  /** Background commands still running. */
  commands: number;
}

interface NodeBase {
  /** Unique across threads: `thread/agent` or `thread/task:id`. */
  key: string;
  /** The thread this row's entity lives in. */
  threadId: string;
  /** It, or anything under it in any thread, works or waits. */
  live: boolean;
  /** It, or anything under it in any thread, waits on the person. */
  needsYou: boolean;
  /**
   * It, or anything under it, shows facts the daemon hasn't confirmed yet, or couldn't be loaded:
   * a settled-looking row with this set may still be working, so it never reads as done.
   */
  unconfirmed: boolean;
  /** Everything below this row, counted once when the forest is built. */
  tally: ForestTally;
  /**
   * Waiting on the person first, then working agents, running commands, and finished agents
   * last, each in the order they started.
   */
  children: ForestNode[];
}

export interface AgentForestNode extends NodeBase {
  kind: "agent";
  agent: Agent;
  /** The delegated thread whose agents hang under it, once loaded. */
  childThread?: string | undefined;
  /** That thread's main agent, whose own requests and state this row speaks for. */
  childRoot?: Agent | undefined;
  /**
   * Its own facts may be behind: its thread is syncing, or (for a delegate) the thread it
   * delegated to is syncing or still loading. It says neither finished nor working as current.
   */
  stale: boolean;
  /** A delegate whose thread couldn't be loaded (no room, or its subscription failed). */
  notLoaded: boolean;
  /**
   * The running task that stands for this agent's work (a subagent task naming it, such as the
   * hold a child on another machine keeps): this row is that work, so no command row repeats it.
   */
  hold?: BackgroundTask | undefined;
}

export interface CommandForestNode extends NodeBase {
  kind: "command";
  task: BackgroundTask;
}

export type ForestNode = AgentForestNode | CommandForestNode;

export interface AgentForest {
  /** The viewed thread's root agents, its main agent first. */
  roots: ForestNode[];
  /** Delegated threads the tree reaches within its bounds, shallowest first: what to load. */
  reach: string[];
  /**
   * The viewed thread's own facts, and every thread the tree shows, are confirmed by the daemon:
   * only then may it read done.
   */
  confirmed: boolean;
}

/**
 * How far the tree follows delegation. Each delegated thread costs one live subscription, and the
 * client keeps at most 32 (types.ts `threads`), shared with every other open view: six levels and
 * sixteen threads show any real delegation chain while leaving room for the rest of the app.
 * Deeper or further threads still show as their delegate's row, only without their own agents.
 */
export const forestBounds = { depth: 6, threads: 16 } as const;

const runningTask = (task: BackgroundTask) =>
  !task.internal && (task.status === "running" || task.status === "unknown");

/**
 * The delegated threads to load, breadth first from `root`: never one already reached (a cycle
 * or a thread delegated twice), never deeper than `bounds.depth`, at most `bounds.threads`.
 */
function reachable(
  root: string,
  works: ReadonlyMap<string, ThreadWork>,
  bounds: { depth: number; threads: number },
): string[] {
  const seen = new Set([root]);
  const reach: string[] = [];
  let level = [root];
  for (let depth = 1; depth <= bounds.depth && level.length; depth++) {
    const next: string[] = [];
    for (const threadId of level)
      for (const agent of works.get(threadId)?.agents ?? []) {
        // A child on another machine has no thread here to load: its row is all there is.
        const child = agent.machine ? undefined : agent.childThreadId;
        if (!child || seen.has(child) || reach.length >= bounds.threads) continue;
        seen.add(child);
        reach.push(child);
        next.push(child);
      }
    level = next;
  }
  return reach;
}

/** One thread's own shape, which changes only when that thread's facts do. */
interface Layer {
  running: ReadonlySet<string>;
  needsYou: ReadonlySet<string>;
  /** Shown agents by the shown parent they hang under (null: the thread's top), oldest first. */
  kids: ReadonlyMap<string | null, readonly Agent[]>;
  /** Running background commands by the shown agent that owns them. */
  commands: ReadonlyMap<string, readonly BackgroundTask[]>;
  /** Running subagent tasks by the shown agent doing the work. */
  holds: ReadonlyMap<string, BackgroundTask>;
}

/**
 * Each thread's layer, kept by its facts object: a thread whose facts didn't change since the last
 * join reuses its layer, so a change in one thread recomputes only that thread's own shape.
 */
export type ForestLayers = WeakMap<ThreadWork, Layer>;
export const forestLayers = (): ForestLayers => new WeakMap();

const byStart = (left: Agent, right: Agent) => left.createdAt - right.createdAt;

function layerOf(facts: ThreadWork): Layer {
  const work = agentTreeWork(facts.agents, facts.tasks, facts.interactions, facts.status);
  const runs = agentRuns(facts.agents);
  const byId = new Map<string, Agent>();
  for (const agent of facts.agents) byId.set(agent.id, agent);
  // An earlier run's row goes when its latest run is here; its subagents follow the latest.
  const shown = (id: string) => {
    const latest = runs.latest.get(id);
    return latest === undefined || !byId.has(latest) ? id : latest;
  };
  const kids = new Map<string | null, Agent[]>();
  for (const agent of facts.agents) {
    if (shown(agent.id) !== agent.id) continue;
    const parent = agent.parentId && byId.has(agent.parentId) ? shown(agent.parentId) : null;
    const bucket = kids.get(parent);
    if (bucket) bucket.push(agent);
    else kids.set(parent, [agent]);
  }
  for (const [parent, bucket] of kids)
    bucket.sort(
      parent === null
        ? (left, right) =>
            Number(right.origin === "root") - Number(left.origin === "root") || byStart(left, right)
        : byStart,
    );
  const commands = new Map<string, BackgroundTask[]>();
  const holds = new Map<string, BackgroundTask>();
  for (const task of facts.tasks)
    if (runningTask(task)) {
      // A subagent task naming an agent in this tree is that agent's work: its row stands for it.
      if (task.kind === "subagent" && task.childAgentId && byId.has(task.childAgentId)) {
        holds.set(shown(task.childAgentId), task);
        continue;
      }
      const owner = byId.has(task.agentId) ? shown(task.agentId) : task.agentId;
      const bucket = commands.get(owner);
      if (bucket) bucket.push(task);
      else commands.set(owner, [task]);
    }
  return { running: work.running, needsYou: work.needsYou, kids, commands, holds };
}

const noTally = (): ForestTally => ({ working: 0, done: 0, syncing: 0, commands: 0 });

/** Add a row and everything below it to a tally. */
function count(into: ForestTally, entry: ForestNode): void {
  if (entry.kind === "command") into.commands++;
  else if (entry.live) into.working++;
  // Settled-looking, but it or something under it isn't confirmed: not done yet.
  else if (entry.unconfirmed) into.syncing++;
  else into.done++;
  into.working += entry.tally.working;
  into.done += entry.tally.done;
  into.syncing += entry.tally.syncing;
  into.commands += entry.tally.commands;
}

/** Its own work failed: the delegate's thread's main agent's, or its own. */
const failed = (node: AgentForestNode) => (node.childRoot ?? node.agent).status.state === "failed";

/**
 * A row's children in reading order: those waiting on the person, failed ones, working ones,
 * running commands, then finished ones.
 */
function ordered(entries: readonly ForestNode[]): ForestNode[] {
  const asks: ForestNode[] = [];
  const failures: ForestNode[] = [];
  const working: ForestNode[] = [];
  const commands: ForestNode[] = [];
  const finished: ForestNode[] = [];
  for (const entry of entries)
    if (entry.kind === "command") commands.push(entry);
    else if (entry.needsYou) asks.push(entry);
    else if (entry.live) working.push(entry);
    else if (failed(entry)) failures.push(entry);
    else finished.push(entry);
  for (const list of [failures, working, commands, finished])
    for (const entry of list) asks.push(entry);
  return asks;
}

/**
 * Join each thread's agents into one tree. An earlier run of an agent a provider started again
 * folds into its latest run (its subagents move under it), as the thread's own tree does. Every
 * node is live while anything under it at any depth works or waits, so a branch never reads done
 * while a delegated great-grandchild still runs. A thread shows once, under the first delegate
 * that reaches it, which also ends any cycle. Linear in the agents and tasks of the joined
 * threads; pass the same `layers` between joins so unchanged threads aren't worked out again.
 */
export function agentForest(
  root: string,
  works: ReadonlyMap<string, ThreadWork>,
  bounds: { depth: number; threads: number } = forestBounds,
  layers: ForestLayers = forestLayers(),
): AgentForest {
  const reach = reachable(root, works, bounds);
  const allowed = new Set(reach);
  const placed = new Set<string>([root]);
  const layer = (facts: ThreadWork) => {
    const kept = layers.get(facts);
    if (kept) return kept;
    const made = layerOf(facts);
    layers.set(facts, made);
    return made;
  };
  const build = (threadId: string): ForestNode[] => {
    const facts = works.get(threadId);
    if (!facts || facts.facts === "not_loaded") return [];
    const { running, needsYou, kids, commands, holds } = layer(facts);
    const syncing = facts.facts === "syncing";
    const visiting = new Set<string>();
    const node = (agent: Agent): AgentForestNode => {
      visiting.add(agent.id);
      const children: ForestNode[] = [];
      for (const child of kids.get(agent.id) ?? [])
        if (!visiting.has(child.id)) children.push(node(child));
      for (const task of commands.get(agent.id) ?? [])
        children.push({
          kind: "command",
          key: `${threadId}/task:${task.id}`,
          threadId,
          task,
          live: true,
          needsYou: false,
          unconfirmed: syncing,
          tally: noTally(),
          children: [],
        });
      visiting.delete(agent.id);
      const child = agent.machine ? undefined : agent.childThreadId;
      const hold = holds.get(agent.id);
      let childThread: string | undefined;
      let childRoot: AgentForestNode | undefined;
      let stale = syncing;
      let notLoaded = false;
      if (child && allowed.has(child) && !placed.has(child)) {
        const delegated = works.get(child);
        // Reached but not reported yet: still loading, so what it shows isn't current.
        if (!delegated || delegated.facts === "syncing") stale = true;
        if (delegated?.facts === "not_loaded") notLoaded = true;
        else if (delegated) {
          placed.add(child);
          childThread = child;
          // The delegated thread's main agent is this row's own work: its agents hang here.
          for (const top of build(child))
            if (top.kind === "agent" && top.agent.origin === "root" && !childRoot) {
              childRoot = top;
              for (const entry of top.children) children.push(entry);
            } else children.push(top);
        }
      }
      const tally = noTally();
      // Work still running for it keeps it live, whatever its own status last said.
      let live = running.has(agent.id) || hold !== undefined || childRoot?.live === true;
      let asks = needsYou.has(agent.id) || childRoot?.needsYou === true;
      // A thread that couldn't load may be working: its branch is as uncertain as a syncing one.
      let unconfirmed = stale || notLoaded || childRoot?.unconfirmed === true;
      for (const entry of children) {
        count(tally, entry);
        live ||= entry.live;
        asks ||= entry.needsYou;
        unconfirmed ||= entry.unconfirmed;
      }
      return {
        kind: "agent",
        key: `${threadId}/${agent.id}`,
        threadId,
        agent,
        childThread,
        childRoot: childRoot?.agent,
        live,
        needsYou: asks,
        unconfirmed,
        stale,
        notLoaded,
        hold,
        tally,
        children: ordered(children),
      };
    };
    return (kids.get(null) ?? []).map(node);
  };
  const roots = build(root);
  // The viewed thread's own facts count on their own: a failed or missing subscription shows no
  // rows at all, and its cached status may say done while it works again.
  const own = works.get(root);
  const settled = own !== undefined && (own.facts ?? "live") === "live";
  return { roots, reach, confirmed: settled && !roots.some((entry) => entry.unconfirmed) };
}

export function forestTally(nodes: readonly ForestNode[]): ForestTally {
  const tally = noTally();
  for (const entry of nodes) count(tally, entry);
  return tally;
}

/** A folded branch in words: "2 working · 1 done", "1 command". */
export function foldWords(tally: ForestTally): string {
  const words: string[] = [];
  if (tally.working) words.push(`${tally.working} working`);
  if (tally.done) words.push(`${tally.done} done`);
  if (tally.syncing) words.push(`${tally.syncing} syncing`);
  if (tally.commands)
    words.push(`${tally.commands} ${tally.commands === 1 ? "command" : "commands"}`);
  return words.join(" · ");
}

/**
 * The agent the person is needed by: the deepest row on the first branch waiting on them, so the
 * Summary names the agent that asks rather than the parents waiting on it.
 */
export function forestAsker(nodes: readonly ForestNode[]): AgentForestNode | undefined {
  const first = nodes.find(
    (entry): entry is AgentForestNode => entry.kind === "agent" && entry.needsYou,
  );
  if (!first) return undefined;
  return forestAsker(first.children) ?? first;
}

/** A row of the tree as drawn: one node, or a run of finished siblings folded into one line. */
export type ForestRow =
  | { kind: "node"; node: ForestNode }
  | { kind: "finished"; key: string; nodes: AgentForestNode[] };

/**
 * A parent's children as rows, with consecutive finished agents (settled, confirmed, loaded, not
 * failed, nothing under them live) folded into one row once there are at least `least` of them. Children come
 * ordered (`agentForest`), so everything live or waiting on the person stays its own row above.
 */
export function foldFinished(
  parentKey: string,
  children: readonly ForestNode[],
  least = 2,
): ForestRow[] {
  const rows: ForestRow[] = [];
  let run: AgentForestNode[] = [];
  let runs = 0;
  const flush = () => {
    if (run.length >= least)
      // Keyed by its parent, so a fold the person opened stays open as more agents finish.
      rows.push({
        kind: "finished",
        key: `${parentKey}/finished${runs++ ? `:${runs}` : ""}`,
        nodes: run,
      });
    else for (const node of run) rows.push({ kind: "node", node });
    run = [];
  };
  for (const node of children) {
    const settled = node.kind === "agent" && !node.live && !node.needsYou && !node.unconfirmed;
    if (settled && !node.notLoaded && !failed(node)) {
      run.push(node);
      continue;
    }
    flush();
    rows.push({ kind: "node", node });
  }
  flush();
  return rows;
}

/** Every row's key, for a lookup of which rows exist. */
export function forestKeys(nodes: readonly ForestNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (list: readonly ForestNode[]) => {
    for (const entry of list) {
      keys.add(entry.key);
      walk(entry.children);
    }
  };
  walk(nodes);
  return keys;
}
