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
  active = new Set<Key>();
  seen = new Set<Key>();
  toolOwners = new Map<string, Key>();
  toolKinds = new Map<string, string>();
  toolRaw = new Map<string, RawPayload[]>();
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
  constructor(root: Key) {
    this.root = root;
  }
  key(kind: string, id: string): Key {
    return `claude:${this.session}:${kind}:${id}`;
  }
  emit(fact: Fact): void {
    this.facts.push(fact);
  }
  ensureRoot(data: Data): void {
    if (this.seen.has(this.root)) return;
    this.session = string(data["session_id"], this.session);
    this.cwd = string(data["cwd"]);
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
    this.emit({
      type: "turn.started",
      agent,
      nativeTurnId: this.key("turn", `${agent}:${++this.turn}`),
      trigger,
    });
  }
  child(spawn: string, owner = this.root, background = false, nativeId?: string): Key {
    const agent = this.children.get(spawn) ?? this.key("child", spawn);
    this.children.set(spawn, agent);
    this.emit({
      type: "agent.seen",
      agent,
      parent: owner,
      spawnedBy: this.key("tool", spawn),
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "claude", nativeId: nativeId ?? spawn },
      cwd: this.cwd,
      background,
    });
    this.seen.add(agent);
    if (nativeId) this.nativeAgents.set(nativeId, agent);
    this.start(agent, "spawn");
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
    else this.emit({ type: "wake.expected", agent: this.root, until: now + 5_000 });
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
