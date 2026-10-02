import type { AgentError, Fact, Key } from "@ace/core";
import type { RunTrigger, ThreadId } from "@ace/protocol";
import { raw, string, type Data } from "./data.ts";
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
  planPath?: string;
  planMarkdown?: string;
};
type Part = { agent: string; data: Data; item: string };
type Background = { agent: string; child?: string; item: string; idleAt?: number };

export class TranslationState {
  rootNative?: string;
  clockOffset?: number;
  sessions = new Map<string, Session>();
  parts = new Map<string, Part>();
  messages = new Map<string, Data>();
  messageParts = new Map<string, Set<string>>();
  answered = new Set<string>();
  liveTools = new Map<string, Set<string>>();
  own = new Set<string>();
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
    ];
  }
  start(id: string, s: Session): Fact[] {
    if (!s.user || (s.active && s.turn === s.user)) return [];
    s.active = true;
    s.hasParts = false;
    s.turn = s.user;
    s.abort = false;
    delete s.error;
    return [
      { type: "turn.started", agent: this.key(id), nativeTurnId: s.turn, trigger: s.trigger },
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
