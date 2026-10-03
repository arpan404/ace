import type { Fact, Key } from "@ace/core";
import { object, string, nativeIdentity } from "./contracts.ts";
export interface Child {
  key: Key;
  parent: Key;
  call: Key;
  turn: string;
  native?: string;
  background: boolean;
  settled: boolean;
  uncertain?: boolean;
  summary?: boolean;
}
/** Child identities belong to task calls until native IDs arrive. No native resume is implied. */
export class Children {
  readonly calls = new Map<Key, Child>();
  private native = new Map<string, Key>();
  private pendingByParent = new Map<Key, Set<Key>>();
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  ensure(call: Key, parent: Key, args: unknown, cwd: string): Fact[] {
    const existing = this.calls.get(call);
    if (existing)
      return this.link(
        existing,
        nativeIdentity(object(args).agentId) ?? nativeIdentity(object(args).resume),
        cwd,
      );
    if (this.calls.size >= this.limit) throw new Error("SDK child identity budget exceeded");
    const input = object(args);
    const key = `child:${call}`;
    const native = nativeIdentity(input.agentId) ?? nativeIdentity(input.resume);
    const child: Child = {
      key,
      parent,
      call,
      turn: `task:${call}`,
      background: false,
      settled: false,
      ...(native ? { native } : {}),
    };
    this.calls.set(call, child);
    let pending = this.pendingByParent.get(parent);
    if (!pending) {
      pending = new Set();
      this.pendingByParent.set(parent, pending);
    }
    pending.add(call);
    if (native) this.native.set(native, key);
    const name = string(input.description);
    const model = string(input.model);
    const role = string(object(input.subagentType).kind);
    return [
      {
        type: "agent.seen",
        agent: key,
        parent,
        spawnedBy: call,
        origin: "provider_subagent",
        fidelity: "placeholder",
        cwd,
        native: { provider: "cursor", ...(native ? { nativeId: native } : {}) },
        ...(name ? { name } : {}),
        ...(model ? { model } : {}),
        ...(role ? { role } : {}),
      },
      { type: "turn.started", agent: key, nativeTurnId: child.turn, trigger: "spawn" },
    ];
  }
  result(call: Key, result: unknown, failed: boolean, cwd: string): Fact[] {
    const child = this.calls.get(call);
    if (!child || child.settled) return [];
    const value = object(object(result).value);
    const native = nativeIdentity(value.agentId);
    const facts: Fact[] = [];
    facts.push(...this.link(child, native, cwd));
    if (Array.isArray(value.conversationSteps) && value.conversationSteps.length)
      facts.push(...this.observe(call, cwd));
    if (value.isBackground === true) {
      if (!child.background) {
        child.background = true;
        facts.push(
          { type: "agent.linked", agent: child.key, background: true },
          this.surviving(child),
        );
      }
    } else if (failed || object(result).status === "success") {
      child.settled = true;
      const pending = this.pendingByParent.get(child.parent);
      pending?.delete(call);
      if (pending?.size === 0) this.pendingByParent.delete(child.parent);
      facts.push({
        type: "turn.ended",
        agent: child.key,
        nativeTurnId: child.turn,
        outcome: failed ? "failed" : "completed",
      });
      if (child.background)
        facts.push({
          type: "background.ended",
          task: `background:${call}`,
          status: failed ? "failed" : "completed",
        });
    }
    return facts;
  }
  /** One-level live or returned task content establishes summary, never full fidelity. */
  observe(call: Key, cwd: string): Fact[] {
    const child = this.calls.get(call);
    if (!child || child.summary) return [];
    child.summary = true;
    return [
      {
        type: "agent.seen",
        agent: child.key,
        parent: child.parent,
        spawnedBy: child.call,
        origin: "provider_subagent",
        fidelity: "summary",
        cwd,
        native: { provider: "cursor", ...(child.native ? { nativeId: child.native } : {}) },
      },
    ];
  }
  private link(child: Child, native: string | undefined, cwd: string): Fact[] {
    if (!native || native === child.native) return [];
    const linked = this.native.get(native);
    if (child.native || (linked && linked !== child.key))
      throw new Error("SDK child identity conflict");
    child.native = native;
    child.summary = true;
    this.native.set(native, child.key);
    return [
      {
        type: "agent.seen",
        agent: child.key,
        parent: child.parent,
        spawnedBy: child.call,
        origin: "provider_subagent",
        fidelity: "summary",
        cwd,
        native: { provider: "cursor", nativeId: native },
      },
    ];
  }
  surviving(child: Child): Fact {
    return {
      type: "background.started",
      agent: child.parent,
      task: `background:${child.call}`,
      kind: "subagent",
      title: "SDK task child; completion unverified",
      childAgent: child.key,
      item: child.call,
      stoppable: false,
    };
  }
  preserveOwned(parent: Key): Fact[] {
    return this.preserveChildren(parent);
  }
  preserve(): Fact[] {
    return this.preserveChildren();
  }
  private preserveChildren(parent?: Key): Fact[] {
    const facts: Fact[] = [];
    const parents = parent === undefined ? this.pendingByParent.keys() : [parent];
    for (const key of parents) {
      const pending = this.pendingByParent.get(key);
      if (!pending) continue;
      for (const call of pending) {
        const child = this.calls.get(call);
        if (child && !child.settled && !child.uncertain) {
          child.uncertain = true;
          pending.delete(call);
          child.background = true;
          facts.push(this.surviving(child));
          facts.push({
            type: "background.ended",
            task: `background:${child.call}`,
            status: "unknown",
            uncertain: true,
          });
        }
      }
      if (!pending.size) this.pendingByParent.delete(key);
    }
    return facts;
  }
  trim(): void {
    for (const [call, child] of this.calls)
      if (child.settled) {
        this.calls.delete(call);
        if (child.native) this.native.delete(child.native);
      }
  }
}
