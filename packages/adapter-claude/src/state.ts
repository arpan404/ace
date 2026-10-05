import type { Fact, Key } from "@ace/core";
import type {
  InteractionRequest,
  RawPayload,
  RunTrigger,
  ProviderErrorDetails,
} from "@ace/protocol";
import { MissingEdges } from "./missing-edges.ts";
import type { ChildUsage } from "./usage.ts";
import { object, raw, string, type Data } from "./native.ts";

export interface NativeTask {
  data: Data;
  owner: Key;
  child?: Key;
  item?: Key;
  background: boolean;
  terminal: boolean;
  terminalStatus?: string;
}
export class ClaudeState {
  readonly root: Key;
  session = "initial";
  model: string | undefined;
  cwd = "";
  processId = "";
  sessionState: string | undefined;
  retryOn: "rate_limit" | "network" | "upstream" | undefined;
  rateBlocks = new Set<string>();
  errors = new Map<
    Key,
    {
      kind: "provider" | "auth" | "quota" | "network";
      message: string;
      details?: ProviderErrorDetails;
    }
  >();
  runTrigger: RunTrigger = "unknown";
  wakeUntil: number | undefined;
  active = new Set<Key>();
  seen = new Set<Key>();
  toolOwners = new Map<string, Key>();
  toolKinds = new Map<string, string>();
  toolFrames = new Map<string, number>();
  rawItems = new Map<Key, Set<Key>>();
  childUsage: ChildUsage = new Map();
  childUsageOverflow = false;
  terminalChildren = new Set<Key>();
  children = new Map<string, Key>();
  bindings: string[] = [];
  nativeAgents = new Map<string, Key>();
  tasks = new Map<string, NativeTask>();
  level = new Set<string>();
  missing = new MissingEdges();
  interactions = new Map<
    string,
    { agent: Key; item: Key; toolId: string; request: InteractionRequest }
  >();
  facts: Fact[] = [];
  diagnostics: RawPayload[] = [];
  sent = false;
  wake: RunTrigger | undefined;
  wakeDuringTurn = false;
  turn = 0;
  nativeQueued = 0;
  contentSeen = new Set<Key>();
  nativeByAgent = new Map<Key, string>();
  constructor(root: Key) {
    this.root = root;
  }
  key(kind: string, id: string): Key {
    return `claude:${this.session}${this.processId ? `:${this.processId}` : ""}:${kind}:${id}`;
  }
  emit(fact: Fact): void {
    this.facts.push(fact);
  }
  ensureRoot(data: Data): void {
    if (this.seen.has(this.root)) {
      if (typeof data["cwd"] === "string") this.cwd = data["cwd"];
      return;
    }
    this.session = string(data["session_id"], this.session);
    this.cwd = string(data["cwd"]);
    this.processId = string(data["process_id"]);
    this.seen.add(this.root);
    this.emit({ type: "process.started" });
    this.emit({
      type: "agent.seen",
      agent: this.root,
      origin: "root",
      fidelity: "full",
      native: { provider: "claude", nativeId: this.session },
      cwd: this.cwd,
    });
  }
  start(agent: Key, trigger: RunTrigger): void {
    if (this.active.has(agent) || this.terminalChildren.has(agent)) return;
    this.active.add(agent);
    this.contentSeen.delete(agent);
    if (agent === this.root) {
      this.runTrigger = trigger;
      this.wakeUntil = undefined;
      this.wake = undefined;
      this.wakeDuringTurn = false;
    }
    this.emit({
      type: "turn.started",
      agent,
      nativeTurnId: this.key("turn", `${agent}:${++this.turn}`),
      trigger,
    });
  }
  child(
    spawn: string,
    owner = this.root,
    background = false,
    nativeId?: string,
    terminalStatus?: string,
  ): Key {
    const agent =
      (nativeId ? this.nativeAgents.get(nativeId) : undefined) ??
      this.children.get(spawn) ??
      this.key("child", spawn);
    const fresh = !this.seen.has(agent);
    if (this.children.get(spawn) !== agent) this.bindings.push(spawn);
    this.children.set(spawn, agent);
    this.emit({
      type: "agent.seen",
      agent,
      parent: owner,
      spawnedBy: this.key("tool", spawn),
      origin: "provider_subagent",
      fidelity: "full",
      native: {
        provider: "claude",
        nativeId: nativeId ?? this.nativeByAgent.get(agent) ?? spawn,
      },
      cwd: this.cwd,
      background,
    });
    this.seen.add(agent);
    if (nativeId) {
      this.nativeAgents.set(nativeId, agent);
      this.nativeByAgent.set(agent, nativeId);
    }
    if (fresh && !terminalStatus) this.start(agent, "spawn");
    return agent;
  }
  agentFor(data: Data): Key {
    const parent = string(data["parent_tool_use_id"]);
    return parent ? (this.children.get(parent) ?? this.root) : this.root;
  }
  expectWake(now: number, task?: NativeTask): void {
    if (task?.data["ambient"] === true) return;
    this.wake = task?.child ? "subagent_result" : (this.wake ?? "background_completion");
    if (this.active.has(this.root)) this.wakeDuringTurn = true;
    else {
      this.wakeUntil = now + 5_000;
      this.emit({ type: "wake.expected", agent: this.root, until: this.wakeUntil });
    }
  }
  notice(
    data: unknown,
    id: string,
    agent = this.root,
    level: "info" | "warning" | "error" = "info",
    message?: string,
  ): void {
    if (message === undefined) {
      this.diagnostics.push(raw(data));
      return;
    }
    this.emit({
      type: "item.upsert",
      agent,
      item: this.key("raw", id),
      draft: { type: "notice", complete: true, level, text: message, raw: [raw(data)] },
    });
  }
  settledItem(agent: Key, item: Key): boolean {
    return this.terminalChildren.has(agent) && this.rawItems.get(agent)?.has(item) === true;
  }
  keepRaw(item: Key, data: unknown, agent = this.root, name?: string): { raw?: RawPayload[] } {
    const items = this.rawItems.get(agent) ?? new Set<Key>();
    this.rawItems.set(agent, items);
    if (!items.has(item)) {
      items.add(item);
      return { raw: [raw(data, name)] };
    }
    // The translator's diagnostic fallback preserves subsequent payloads once.
    return {};
  }
  keepToolRaw(id: string, data: unknown, name?: string): { raw?: RawPayload[] } {
    return this.keepRaw(this.key("tool", id), data, this.toolOwners.get(id), name);
  }
  keepMessageRaw(item: Key, data: unknown, agent = this.root): { raw?: RawPayload[] } {
    return this.keepRaw(item, data, agent);
  }
  releaseTurn(): void {
    this.rawItems.delete(this.root);
    this.errors.delete(this.root);
  }
  endChild(task: NativeTask, status: string): void {
    if (!task.child) return;
    const alreadyEnded = this.terminalChildren.has(task.child);
    this.terminalChildren.add(task.child);
    // Keep compact item ids so late enrichment cannot replace the first raw payload.

    this.contentSeen.delete(task.child);
    this.errors.delete(task.child);
    if (!this.active.delete(task.child) && alreadyEnded) return;
    this.emit({
      type: "turn.ended",
      agent: task.child,
      trigger: "spawn",
      outcome:
        status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
      ...(status === "failed"
        ? {
            error: {
              kind: "provider" as const,
              message: string(object(task.data["patch"])["error"], "Claude task failed"),
            },
          }
        : {}),
    });
  }
}
