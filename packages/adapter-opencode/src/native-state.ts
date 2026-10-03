import type { RunTrigger, InteractionResolution } from "@ace/protocol";
import type { Fact, Key } from "@ace/core";
import type { Data } from "./data.ts";
import { object, raw, string, number } from "./data.ts";
import { RecentMap, RecentSet } from "./cache.ts";
export type Tool = { session: string; message: string; name: string; input: Data; live: boolean };
export class NativeState {
  readonly rootKey: Key;
  rootNative = "";
  disconnected = false;
  agents = new Map<string, { parent: string; directory: string }>();
  active = new Map<string, string>();
  idle = new Map<string, number>();
  executionBaseline = new Map<string, number>();
  executionCreated = new Map<string, number>();
  triggers = new Map<string, RunTrigger>();
  ended = new RecentSet();
  events = new RecentSet();
  durable = new RecentMap<number>(1024);
  childClaims = new Map<string, { session: string; item: string; background: boolean }>();
  tools = new Map<string, Tool>();
  liveMessages = new Map<string, Map<string, number>>();
  recentTools = new RecentMap<Tool>(1024);
  inputs = new Map<string, string>();
  commands = new Map<string, string>();
  admitted = new RecentSet();
  admissionPending = new Set<string>();
  pending = new Map<
    string,
    { session: string; data: Data; type: string; resolution?: InteractionResolution }
  >();
  shells = new Map<string, string>();
  wakeShells = new Set<string>();
  wakes = new Map<string, number>();
  backgrounds = new Map<string, string>();
  completedBackgrounds = new RecentSet();
  completedChildren = new Set<string>();
  unknown = 0;
  constructor(rootKey: Key) {
    this.rootKey = rootKey;
  }
  trackTool(item: string, current: Tool): void {
    const previous = this.tools.get(item);
    if (!current.live) {
      this.tools.delete(item);
      this.recentTools.set(item, current);
      if (previous) {
        const messages = this.liveMessages.get(previous.session);
        const count = messages?.get(previous.message) ?? 0;
        if (count <= 1) messages?.delete(previous.message);
        else messages?.set(previous.message, count - 1);
        if (!messages?.size) this.liveMessages.delete(previous.session);
      }
      return;
    }
    if (this.tools.size >= 2048 && !previous) throw new Error("OpenCode tool limit");
    this.tools.set(item, current);
    if (!previous) {
      const messages = this.liveMessages.get(current.session) ?? new Map<string, number>();
      messages.set(current.message, (messages.get(current.message) ?? 0) + 1);
      this.liveMessages.set(current.session, messages);
    }
  }
  key(id: string): string {
    return id === this.rootNative ? this.rootKey : id;
  }
  note(data: unknown, name: string): Fact[] {
    return [
      {
        type: "item.upsert",
        agent: this.rootKey,
        item: `native-notice:${++this.unknown % 128}`,
        draft: { type: "notice", level: "info", text: name, raw: raw(name, data) },
      },
    ];
  }
  seen(p: Data): Fact[] {
    const id = string(p.id, string(p.sessionID)),
      parent = id === this.rootNative ? "" : string(p.parentID);
    if (!id || (!this.rootNative && p.fork)) return [];
    if (!this.rootNative && !parent) this.rootNative = id;
    if (id !== this.rootNative && (!parent || !this.agents.has(parent) || p.fork)) return [];
    if (this.agents.size >= 1024 && !this.agents.has(id)) throw new Error("OpenCode agent limit");
    const directory = string(object(p.location).directory);
    const claim = this.childClaims.get(id);
    this.childClaims.delete(id);
    this.agents.set(id, { parent, directory });
    this.idle.set(id, number(object(p.time).idle, -1));
    return [
      {
        type: "agent.seen",
        agent: this.key(id),
        ...(parent ? { parent: this.key(parent) } : {}),
        origin: parent ? "provider_subagent" : "root",
        fidelity: "full",
        cwd: directory,
        native: { provider: "opencode", nativeId: id },
        name: string(p.title),
        role: string(p.agent),
      },
      ...(this.disconnected ? [{ type: "agent.disconnected" as const, agent: this.key(id) }] : []),
      ...(claim && claim.session === parent
        ? [
            ...this.finishBackground(`proof:${id}`, "completed"),
            {
              type: "agent.linked" as const,
              agent: this.key(id),
              parent: this.key(parent),
              spawnedBy: claim.item,
              background: claim.background,
            },
            ...(claim.background
              ? this.background(`child:${id}`, parent, "subagent", claim.item)
              : []),
          ]
        : []),
    ];
  }
  start(id: string, turn: string): Fact[] {
    this.wakes.delete(id);
    if (this.active.has(id) || this.ended.has(turn)) return [];
    this.active.set(id, turn);
    this.executionBaseline.set(id, this.idle.get(id) ?? -1);
    this.executionCreated.delete(id);
    return [
      {
        type: "turn.started",
        agent: this.key(id),
        nativeTurnId: turn,
        trigger: this.triggers.get(id) ?? (this.agents.get(id)?.parent ? "spawn" : "unknown"),
      },
      { type: "retry.cleared", agent: this.key(id) },
    ];
  }
  canSettle(id: string, idleAt: number): boolean {
    return (
      !this.active.has(id) ||
      (idleAt > (this.executionBaseline.get(id) ?? -1) &&
        idleAt >= (this.executionCreated.get(id) ?? -1))
    );
  }
  reconcileOutcome(info: Data): Fact[] {
    const id = string(info.id),
      idleAt = number(object(info.time).idle, -1);
    if (
      !this.active.has(id) ||
      !this.canSettle(id, idleAt) ||
      !["succeeded", "failed", "interrupted"].includes(string(info.outcome))
    )
      return [];
    return this.end(
      id,
      info.outcome === "failed"
        ? "failed"
        : info.outcome === "interrupted"
          ? "interrupted"
          : "completed",
    );
  }
  end(id: string, outcome: "completed" | "failed" | "interrupted", error?: unknown): Fact[] {
    const turn = this.active.get(id);
    if (!turn) return [];
    this.active.delete(id);
    this.ended.add(turn);
    return [
      { type: "retry.cleared", agent: this.key(id) },
      {
        type: "turn.ended",
        agent: this.key(id),
        nativeTurnId: turn,
        outcome,
        ...(outcome === "failed"
          ? {
              error: {
                kind: "provider" as const,
                message: string(object(error).message, "OpenCode execution failed"),
              },
            }
          : {}),
      },
    ];
  }
  admit(id: string, session: string): Fact[] {
    if (this.admitted.has(id)) return [];
    this.admitted.add(id);
    this.admissionPending.delete(id);
    const commandId = this.commands.get(id);
    return [
      {
        type: "input.admitted",
        agent: this.key(session),
        nativeInputId: id,
        ...(commandId === undefined ? {} : { commandId }),
      },
    ];
  }
  queue(): Fact[] {
    return [
      {
        type: "queue.changed",
        count: this.inputs.size - this.admissionPending.size,
        source: "provider",
      },
    ];
  }
  input(id: string, session: string): Fact[] {
    if (this.inputs.size >= 1024 && !this.inputs.has(id)) throw new Error("OpenCode inbox limit");
    this.inputs.set(id, session);
    return this.queue();
  }
  background(
    task: string,
    session: string,
    kind: "shell" | "subagent" | "other",
    item?: string,
  ): Fact[] {
    if (
      this.backgrounds.has(task) ||
      this.completedBackgrounds.has(task) ||
      this.completedChildren.has(task)
    )
      return [];
    if (this.backgrounds.size >= 2048) throw new Error("OpenCode work limit");
    this.backgrounds.set(task, session);
    return [
      {
        type: "background.started",
        agent: this.key(session),
        task,
        kind,
        title: kind === "shell" ? "OpenCode shell" : "OpenCode background work",
        stoppable: true,
        ...(item ? { item } : {}),
        ...(kind === "subagent" ? { childAgent: this.key(task.slice(6)) } : {}),
      },
    ];
  }
  finishBackground(task: string, status: "completed" | "failed" | "stopped"): Fact[] {
    const exists = this.backgrounds.has(task);
    this.backgrounds.delete(task);
    if (task.startsWith("child:")) {
      if (this.completedChildren.size >= 1024 && !this.completedChildren.has(task))
        throw new Error("OpenCode child completion limit");
      this.completedChildren.add(task);
    } else if (exists || task.startsWith("shell:")) this.completedBackgrounds.add(task);
    if (!exists) return [];
    return [{ type: "background.ended", task, status }];
  }
  wake(id: string, created = Number.MAX_SAFE_INTEGER): Fact[] {
    this.wakes.set(id, created);
    return [{ type: "wake.expected", agent: this.key(id), until: Number.MAX_SAFE_INTEGER }];
  }
  reconcileWake(id: string, idleAt: number): Fact[] {
    const created = this.wakes.get(id);
    if (created === undefined || idleAt < created) return [];
    this.wakes.delete(id);
    return [{ type: "wake.expected", agent: this.key(id), until: 0 }];
  }
  completion(metadata: Data): Fact[] {
    const task =
      metadata.source === "subagent"
        ? `child:${string(metadata.childID)}`
        : metadata.source === "shell"
          ? `shell:${string(metadata.shellID)}`
          : "";
    if (!task) return [];
    return this.finishBackground(
      task,
      metadata.state === "error"
        ? "failed"
        : metadata.state === "cancelled"
          ? "stopped"
          : "completed",
    );
  }
  settled(): boolean {
    return (
      !this.disconnected &&
      !this.active.size &&
      !this.inputs.size &&
      !this.pending.size &&
      !this.backgrounds.size &&
      !this.childClaims.size &&
      !this.wakes.size
    );
  }
}
