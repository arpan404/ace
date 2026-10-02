import type { AgentError, Fact, Key } from "@ace/core";
import type { RunTrigger, ThreadId } from "@ace/protocol";
import { object, raw, string, type Data } from "./data.ts";
import { RecentMap, RecentSet } from "./cache.ts";
import type { Pending } from "./interactions.ts";
type Session = {
  active: boolean;
  status: "idle" | "busy" | "retry";
  retrying: boolean;
  hasParts: boolean;
  user?: string;
  turn?: string;
  trigger: RunTrigger;
  abort: boolean;
  error?: AgentError;
  sent: boolean;
  awaiting: boolean;
  userOrder?: number;
  answered: boolean;
  planPath?: string;
  planMarkdown?: string;
};
type Part = { agent: string; data: Data; item: string };
type Background = { agent: string; child?: string; item: string; idleAt?: number };

export class TranslationState {
  rootNative?: string;
  disconnected = false;
  clockOffset?: number;
  sessions = new Map<string, Session>();
  parts = new Map<string, Part>();
  private partKeys = new Map<string, Set<string>>();
  recentParts = new RecentMap<Part>(256);
  messages = new RecentMap<Data>(1024);
  liveTools = new Map<string, Set<string>>();
  liveToolCount = 0;
  private dirty = new Set<string>();
  private unsettled = new Set<string>();
  graceDirty = false;
  graceDeadline: number | undefined;
  own = new RecentSet();
  delivered = new RecentSet();
  pending = new Map<string, Pending>();
  backgrounds = new Map<string, Background>();
  seenEvents = new Set<string>();
  mcp = new Set<string>();
  unknown = 0;
  rootKey: Key;

  constructor(init: { threadId: ThreadId; rootKey: Key }) {
    this.rootKey = init.rootKey;
  }
  key(id: string): string {
    return id === this.rootNative ? this.rootKey : id;
  }
  session(id: string): Session {
    this.dirty.add(id);
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        active: false,
        status: "idle",
        retrying: false,
        hasParts: false,
        trigger: "unknown",
        abort: false,
        sent: false,
        awaiting: false,
        answered: false,
      };
      this.sessions.set(id, state);
    }
    return state;
  }
  seen(info: Data): Fact[] {
    const id = string(info.id);
    if (!id) return [];
    const parent = string(info.parentID);
    if (!parent && !this.rootNative) this.rootNative = id;
    this.session(id);
    return [
      {
        type: "agent.seen",
        agent: this.key(id),
        ...(parent ? { parent: this.key(parent) } : {}),
        origin: parent ? "provider_subagent" : "root",
        fidelity: "full",
        native: { provider: "opencode", nativeId: id },
        cwd: string(info.directory),
        name: string(info.title),
        role: string(info.agent),
      },
      ...(this.disconnected ? [{ type: "agent.disconnected" as const, agent: this.key(id) }] : []),
    ];
  }
  start(id: string, s: Session): Fact[] {
    if (!s.user || (s.active && s.turn === s.user)) return [];
    s.active = true;
    s.awaiting = false;
    s.hasParts = false;
    s.turn = s.user;
    s.abort = false;
    delete s.error;
    return [
      { type: "turn.started", agent: this.key(id), nativeTurnId: s.turn, trigger: s.trigger },
    ];
  }
  getPart(id: string): Part | undefined {
    return this.parts.get(id) ?? this.recentParts.get(id);
  }
  rememberPart(id: string, item: string, data: Data, live: boolean): void {
    // Only routing/settlement metadata belongs here; core owns accumulated content.
    const native = object(data.state);
    const meta = object(native.metadata);
    const part = {
      agent: string(data.sessionID),
      item,
      data: {
        type: data.type,
        tool: data.tool,
        state: {
          status: data.type === "tool" && live ? "running" : native.status,
          title: native.title,
          metadata: { background: meta.background, sessionId: meta.sessionId },
        },
      },
    };
    for (const key of new Set([id, item])) {
      const previous = this.parts.get(key);
      if (previous) {
        const keys = this.partKeys.get(previous.agent);
        keys?.delete(key);
        if (!keys?.size) this.partKeys.delete(previous.agent);
      }
      this.parts.delete(key);
      this.recentParts.delete(key);
      if (live) {
        this.parts.set(key, part);
        const keys = this.partKeys.get(part.agent) ?? new Set<string>();
        keys.add(key);
        this.partKeys.set(part.agent, keys);
      } else this.recentParts.set(key, part);
    }
  }
  settleParts(id: string): void {
    const keys = this.partKeys.get(id);
    for (const key of keys ?? []) {
      const part = this.parts.get(key);
      if (part && part.data.type !== "tool") {
        this.parts.delete(key);
        keys?.delete(key);
        this.recentParts.set(key, part);
      }
    }
    if (!keys?.size) this.partKeys.delete(id);
  }
  refresh(): void {
    for (const id of this.dirty) {
      const s = this.sessions.get(id);
      if (s && (s.active || s.awaiting || s.sent || s.status !== "idle")) this.unsettled.add(id);
      else this.unsettled.delete(id);
    }
    this.dirty.clear();
    if (this.graceDirty) {
      this.graceDeadline = undefined;
      for (const bg of this.backgrounds.values())
        if (bg.idleAt !== undefined)
          this.graceDeadline = Math.min(this.graceDeadline ?? Infinity, bg.idleAt + 3000);
      this.graceDirty = false;
    }
  }
  settled(): boolean {
    return (
      !this.pending.size && !this.backgrounds.size && !this.liveToolCount && !this.unsettled.size
    );
  }
  metadata(name: string, key: string, data: unknown): Fact[] {
    return [
      {
        type: "item.upsert",
        agent: this.rootKey,
        item: `native:${name}:${key}`,
        draft: {
          type: "notice",
          complete: true,
          level: "info",
          text: `OpenCode ${name}`,
          raw: raw(name, data),
        },
      },
    ];
  }
  notice(data: unknown, name: string): Fact[] {
    return [
      {
        type: "item.upsert",
        agent: this.rootKey,
        item: `raw:${++this.unknown}`,
        draft: {
          type: "notice",
          complete: true,
          level: "info",
          text: `OpenCode ${name}`,
          raw: raw(name, data),
        },
      },
    ];
  }
}
