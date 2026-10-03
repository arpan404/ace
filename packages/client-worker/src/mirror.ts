import {
  Notifications,
  type ClientError,
  type Selection,
  type SidebarExport,
  type SidebarKey,
  type SidebarReader,
  type SidebarSource,
  type ThreadExport,
  type ThreadKey,
  type ThreadReader,
  type ThreadSource,
} from "@ace/client";
import type { ContextMeter, Item, ThreadListEntry, ThreadView } from "@ace/protocol";
import { splitKey, type AgentLinks, type Patch } from "./patches.ts";
import { toError, trusted } from "./trusted.ts";
import type { ErrorShape } from "./wire.ts";

/*
 * A tab's copy of a store that lives in the worker. Selectors read it synchronously, exactly as
 * they read an in-process store; each patch notifies the same keys the worker's store emitted.
 */

const errorOf = (shape: ErrorShape | undefined) => shape && toError(shape);
const none: readonly string[] = [];
const entries = <T>(record: Record<string, T> | undefined) => new Map(Object.entries(record ?? {}));

type View = NonNullable<ThreadExport["view"]>;

export class MirrorThread implements ThreadSource {
  private notifications: Notifications;
  private failure: ClientError | undefined;
  private meta: ThreadView["thread"] | undefined;
  private queued: ThreadView["queue"] | undefined;
  private ids: readonly string[] = none;
  private seq: number | undefined;
  private before: number | null | undefined;
  private links: AgentLinks = { ids: none, children: {} };
  private interactionList: readonly string[] = none;
  private taskList: readonly string[] = none;
  private items = new Map<string, Item>();
  private agents = new Map<string, View["agents"][string]>();
  private runs = new Map<string, View["runs"][string]>();
  private interactions = new Map<string, View["interactions"][string]>();
  private tasks = new Map<string, View["backgroundTasks"][string]>();
  private usages = new Map<string, View["usage"][string]>();
  private meters = new Map<string, ContextMeter>();
  private snapshots = new Map<string, View["usageSnapshots"][string]>();
  private cut = new Set<string>();
  constructor(listeners: number) {
    this.notifications = new Notifications(listeners);
  }
  get error() {
    return this.failure;
  }
  get thread() {
    return this.meta;
  }
  get queue() {
    return this.queued;
  }
  get context() {
    const root = this.meta?.rootAgentId;
    return root ? this.meters.get(root) : undefined;
  }
  get order() {
    return this.ids;
  }
  get cursor() {
    return this.seq;
  }
  get itemsBefore() {
    return this.before;
  }
  agentIds() {
    return this.links.ids;
  }
  children(agentId: string): readonly string[] {
    return [...(this.links.children[agentId] ?? none)];
  }
  interactionIds() {
    return this.interactionList;
  }
  taskIds() {
    return this.taskList;
  }
  item(id: string) {
    return this.items.get(id);
  }
  agent(id: string) {
    return this.agents.get(id);
  }
  run(id: string) {
    return this.runs.get(id);
  }
  interaction(id: string) {
    return this.interactions.get(id);
  }
  task(id: string) {
    return this.tasks.get(id);
  }
  usage(id: string) {
    return this.usages.get(id);
  }
  contextMeter(id: string) {
    return this.meters.get(id);
  }
  usageSnapshot(key: string) {
    return this.snapshots.get(key);
  }
  truncated(id: string) {
    return this.cut.has(id);
  }
  select<T>(
    keys: readonly ThreadKey[],
    selector: (reader: ThreadReader) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T> {
    return this.notifications.select(keys, () => selector(this), equal);
  }
  reset(copy: ThreadExport): void {
    const view = copy.view;
    this.failure = errorOf(copy.error);
    this.meta = view?.thread;
    this.queued = view?.queue;
    this.ids = view?.itemOrder ?? none;
    this.seq = view?.seq;
    this.before = view?.itemsBefore;
    const agentIds = Object.keys(view?.agents ?? {});
    this.links = { ids: agentIds, children: view?.agentChildren ?? {} };
    this.interactionList = Object.keys(view?.interactions ?? {});
    this.taskList = Object.keys(view?.backgroundTasks ?? {});
    this.items = entries(view?.items);
    this.agents = entries(view?.agents);
    this.runs = entries(view?.runs);
    this.interactions = entries(view?.interactions);
    this.tasks = entries(view?.backgroundTasks);
    this.usages = entries(view?.usage);
    this.meters = entries(view?.contextMeters);
    this.snapshots = entries(view?.usageSnapshots);
    this.cut = new Set(copy.truncated);
    this.notifications.emitAll();
  }
  apply(patches: readonly Patch[]): void {
    const keys = new Set<string>();
    for (const patch of patches) {
      keys.add(patch.k);
      this.patch(patch);
    }
    this.notifications.emit(keys);
  }
  private patch(patch: Patch): void {
    const { kind, id } = splitKey(patch.k);
    const v = patch.v;
    switch (kind) {
      case "error":
        this.failure = errorOf(trusted<ErrorShape | undefined>(v));
        return;
      case "thread":
        this.meta = trusted<ThreadView["thread"] | undefined>(v);
        return;
      case "queue":
        this.queued = trusted<ThreadView["queue"]>(v);
        return;
      case "order":
        this.ids = trusted<readonly string[] | undefined>(v) ?? none;
        return;
      case "cursor":
        this.seq = trusted<number | undefined>(v);
        return;
      case "history":
        this.before = trusted<number | null | undefined>(v);
        return;
      case "agents":
        this.links = trusted<AgentLinks | undefined>(v) ?? { ids: none, children: {} };
        return;
      case "interactions":
        this.interactionList = trusted<readonly string[] | undefined>(v) ?? none;
        return;
      case "tasks":
        this.taskList = trusted<readonly string[] | undefined>(v) ?? none;
        return;
      case "item":
        this.patchItem(id, patch);
        return;
      case "agent":
        return set(this.agents, id, v);
      case "run":
        return set(this.runs, id, v);
      case "interaction":
        return set(this.interactions, id, v);
      case "task":
        return set(this.tasks, id, v);
      case "context":
        return set(this.meters, id, v);
      case "usage":
        return set(this.usages, id, v);
      case "usageSnapshot":
        return set(this.snapshots, id, v);
    }
  }
  private patchItem(id: string, patch: Patch): void {
    if (patch.cut) this.cut.add(id);
    else this.cut.delete(id);
    if (patch.append === undefined) return set(this.items, id, patch.v);
    const item = this.items.get(id);
    if (item?.type !== "message") return;
    const parts = [...item.parts];
    const last = parts.at(-1);
    if (last?.type !== "text") return;
    parts[parts.length - 1] = { ...last, text: last.text + patch.append };
    this.items.set(id, { ...item, parts });
  }
}

function set<T>(map: Map<string, T>, id: string, value: unknown): void {
  if (value === undefined) map.delete(id);
  else map.set(id, trusted<T>(value));
}

export class MirrorSidebar implements SidebarSource {
  private notifications: Notifications;
  private failure: ClientError | undefined;
  private list: readonly string[] = none;
  private threads = new Map<string, ThreadListEntry>();
  private snapshot = false;
  constructor(listeners: number) {
    this.notifications = new Notifications(listeners);
  }
  get error() {
    return this.failure;
  }
  get loaded() {
    return this.snapshot;
  }
  get ids() {
    return this.list;
  }
  thread(id: string) {
    return this.threads.get(id);
  }
  select<T>(
    keys: readonly SidebarKey[],
    read: (sidebar: SidebarReader) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T> {
    return this.notifications.select(keys, () => read(this), equal);
  }
  reset(copy: SidebarExport): void {
    this.failure = errorOf(copy.error);
    this.list = copy.ids;
    this.snapshot = copy.view !== undefined;
    this.threads = entries(copy.view?.threads);
    this.notifications.emitAll();
  }
  apply(patches: readonly Patch[]): void {
    const keys = new Set<string>();
    for (const patch of patches) {
      keys.add(patch.k);
      const { kind, id } = splitKey(patch.k);
      if (kind === "ids") this.list = trusted<readonly string[] | undefined>(patch.v) ?? none;
      else if (kind === "thread") set(this.threads, id, patch.v);
      else this.failure = errorOf(trusted<ErrorShape | undefined>(patch.v));
    }
    this.notifications.emit(keys);
  }
}
