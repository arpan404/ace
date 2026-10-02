import type { Fact, Key } from "@ace/core";
import type { InteractionRequest, RawPayload, RunTrigger } from "@ace/protocol";
import { object, raw, string, type Data } from "./native.ts";

export interface NativeTask {
  data: Data;
  owner: Key;
  child?: Key;
  item?: Key;
  background: boolean;
  terminal: boolean;
}
export class ClaudeState {
  readonly root: Key;
  session = "initial";
  cwd = "";
  processId = "";
  sessionState: string | undefined;
  errors = new Map<Key, { kind: "provider" | "auth" | "quota" | "network"; message: string }>();
  runTrigger: RunTrigger = "unknown";
  wakeUntil: number | undefined;
  active = new Set<Key>();
  seen = new Set<Key>();
  toolOwners = new Map<string, Key>();
  toolKinds = new Map<string, string>();
  toolRaw = new Map<string, RawPayload[]>();
  messageRaw = new Map<string, RawPayload[]>();
  children = new Map<string, Key>();
  nativeAgents = new Map<string, Key>();
  tasks = new Map<string, NativeTask>();
  level = new Set<string>();
  missing = new Map<string, number>();
  interactions = new Map<string, { agent: Key; item: Key; request: InteractionRequest }>();
  facts: Fact[] = [];
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
    if (this.active.has(agent)) return;
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
  child(spawn: string, owner = this.root, background = false, nativeId?: string): Key {
    const agent =
      this.children.get(spawn) ??
      (nativeId ? this.nativeAgents.get(nativeId) : undefined) ??
      this.key("child", spawn);
    const fresh = !this.seen.has(agent);
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
    if (fresh) this.start(agent, "spawn");
    return agent;
  }
  agentFor(data: Data): Key {
    const parent = string(data["parent_tool_use_id"]);
    return parent ? (this.children.get(parent) ?? this.child(parent)) : this.root;
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
    message = "Claude frame",
  ): void {
    this.emit({
      type: "item.upsert",
      agent,
      item: this.key("raw", id),
      draft: { type: "notice", complete: true, level, text: message, raw: [raw(data)] },
    });
  }
  keepToolRaw(id: string, data: unknown, name?: string): RawPayload[] {
    const entries = [...(this.toolRaw.get(id) ?? []), raw(data, name)];
    this.toolRaw.set(id, entries);
    return entries;
  }
  keepMessageRaw(item: Key, data: unknown): RawPayload[] {
    const entries = [...(this.messageRaw.get(item) ?? []), raw(data)];
    this.messageRaw.set(item, entries);
    return entries;
  }
  endChild(task: NativeTask, status: string): void {
    if (!task.child || !this.active.delete(task.child)) return;
    this.emit({
      type: "turn.ended",
      agent: task.child,
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
