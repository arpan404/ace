import type { AgentError, Fact, Key } from "@ace/core";
import type { RunTrigger, ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "./contract.ts";
import { array, number, object, raw, string, retryReason, type Data } from "./data.ts";
import { request, resolution, type Pending } from "./interactions.ts";
import { detail, toolStatus } from "./tools.ts";

type Session = {
  active: boolean;
  user?: string;
  turn?: string;
  trigger: RunTrigger;
  abort: boolean;
  error?: AgentError;
  sent: boolean;
  planPath?: string;
};
type Part = { agent: string; data: Data; item: string };
type Background = { agent: string; child?: string; item: string; idleAt?: number };

/** v1 HTTP + global SSE translator. Native IDs are stable across REST resyncs. */
export class OpenCodeTranslator implements Translator {
  private rootNative?: string;
  private sessions = new Map<string, Session>();
  private parts = new Map<string, Part>();
  private messages = new Map<string, Data>();
  private own = new Set<string>();
  private pending = new Map<string, Pending>();
  private backgrounds = new Map<string, Background>();
  private seenEvents = new Set<string>();
  private mcp = new Set<string>();
  private unknown = 0;
  private rootKey: Key;

  constructor(init: { threadId: ThreadId; rootKey: Key }) {
    this.rootKey = init.rootKey;
  }
  private key(id: string): string {
    return id === this.rootNative ? this.rootKey : id;
  }
  private session(id: string): Session {
    let state = this.sessions.get(id);
    if (!state) {
      state = { active: false, trigger: "unknown", abort: false, sent: false };
      this.sessions.set(id, state);
    }
    return state;
  }
  private seen(info: Data): Fact[] {
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
  private start(id: string, s: Session): Fact[] {
    if (s.active || !s.user) return [];
    s.active = true;
    s.turn = s.user;
    s.abort = false;
    delete s.error;
    return [
      { type: "turn.started", agent: this.key(id), nativeTurnId: s.turn, trigger: s.trigger },
    ];
  }
  private notice(data: unknown, name: string): Fact[] {
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
  translate(frame: Frame, now: number): Fact[] {
    // Provider frames are JSON. Invalid shapes remain available as raw notices.
    try {
      return this.frame(frame, now);
    } catch {
      return this.notice(frame.data, "malformed frame");
    }
  }
  private frame(frame: Frame, now: number): Fact[] {
    const data = object(frame.data);
    if (frame.channel === "lifecycle") {
      if (data.type === "started") return [{ type: "process.started" }];
      if (data.type === "exited")
        return [
          {
            type: "process.exited",
            deliberate: data.deliberate === true,
            message: string(data.message),
          },
        ];
      if (data.type === "disconnected") {
        const facts: Fact[] = [...this.pending.keys()].map((interaction) => ({
          type: "interaction.closed",
          interaction,
          state: "expired",
        }));
        this.pending.clear();
        return facts;
      }
      return [];
    }
    if (frame.channel === "http") return this.http(frame, data, now);
    if (frame.channel !== "sse") return this.notice(frame.data, frame.channel);
    const payload = object(data.payload ?? data);
    const type = string(payload.type);
    if (type === "sync") return [{ type: "signal" }]; // Durable twin; never apply it twice.
    const eventId = string(payload.id);
    if (eventId && this.seenEvents.has(eventId)) return [{ type: "signal" }];
    if (eventId) {
      this.seenEvents.add(eventId);
      if (this.seenEvents.size > 10_000)
        this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const p = object(payload.properties);
    const id = string(
      p.sessionID,
      string(object(p.info).sessionID, string(object(p.part).sessionID)),
    );
    const facts: Fact[] = [{ type: "signal" }];
    const agent = this.key(id);
    const s = this.session(id);
    if (type === "session.created" || type === "session.updated")
      return [...facts, ...this.seen(object(p.info))];
    if (type === "session.status") {
      const status = object(p.status);
      if (status.type === "retry")
        return [
          ...facts,
          {
            type: "retry",
            agent,
            on: retryReason(string(status.message)),
            attempt: number(status.attempt, 1),
            until: number(status.next),
            message: string(status.message),
          },
        ];
      facts.push({ type: "retry.cleared", agent });
      if (status.type === "busy") {
        facts.push(...this.start(id, s));
        return facts;
      }
      if (status.type !== "idle") return [...facts, ...this.notice(frame.data, type)];
      for (const bg of this.backgrounds.values()) if (bg.child === id) bg.idleAt = now;
      if (
        !s.active &&
        s.user &&
        !s.turn &&
        [...this.messages.values()].some(
          (m) =>
            m.role === "assistant" &&
            m.parentID === s.user &&
            typeof object(m.time).completed === "number",
        )
      )
        facts.push(...this.start(id, s));
      if (!s.active) return facts;
      // A native idle does not prove that a running tool stopped, especially on abort.
      for (const part of this.parts.values()) {
        const state = object(part.data.state);
        if (
          part.agent !== id ||
          part.data.type !== "tool" ||
          !["pending", "running"].includes(string(state.status))
        )
          continue;
        if ([...this.backgrounds.values()].some((bg) => bg.item === part.item)) continue;
        const task = `survivor:${part.item}`;
        this.backgrounds.set(task, { agent: id, item: part.item });
        facts.push({
          type: "background.started",
          agent,
          task,
          kind:
            part.data.tool === "task" ? "subagent" : part.data.tool === "bash" ? "shell" : "other",
          title: string(state.title, string(part.data.tool)),
          item: part.item,
          stoppable: true,
        });
      }
      s.active = false;
      facts.push({
        type: "turn.ended",
        agent,
        ...(s.turn ? { nativeTurnId: s.turn } : {}),
        outcome: s.abort ? "interrupted" : s.error ? "failed" : "completed",
        ...(s.error ? { error: s.error } : {}),
      });
      return facts;
    }
    if (type === "session.error") {
      const error = object(p.error);
      const name = string(error.name);
      if (name === "MessageAbortedError") s.abort = true;
      else
        s.error = {
          kind:
            name === "ProviderAuthError"
              ? "auth"
              : name === "APIError" || name === "ContextOverflowError"
                ? "provider"
                : "unknown",
          message: string(object(error.data).message, name),
        };
      return [...facts, ...this.notice(frame.data, type)];
    }
    if (type === "message.updated") {
      const info = object(p.info);
      const msg = string(info.id);
      const previous = this.messages.get(msg);
      this.messages.set(msg, info);
      if (info.role === "user" && !previous) {
        s.user = msg;
        s.trigger = this.own.has(msg) || s.sent ? "user" : "unknown";
        if (s.sent) {
          this.own.add(msg);
          s.sent = false;
        }
        if (!s.active) facts.push({ type: "wake.expected", agent, until: Number.MAX_SAFE_INTEGER });
      }
      if (info.role === "assistant") {
        if (!s.user && typeof info.parentID === "string") s.user = info.parentID;
        if (info.error) {
          const error = object(info.error);
          if (error.name === "MessageAbortedError") s.abort = true;
          else
            s.error = {
              kind: error.name === "ProviderAuthError" ? "auth" : "provider",
              message: string(object(error.data).message, string(error.name)),
            };
        }
      }
      return facts;
    }
    if (type === "message.part.updated") return [...facts, ...this.part(object(p.part), now)];
    if (type === "message.part.delta") {
      const part = this.parts.get(string(p.partID));
      if (!part) return [...facts, ...this.notice(frame.data, type)];
      const field =
        part.data.type === "reasoning"
          ? "reasoning"
          : part.data.type === "text"
            ? "text"
            : p.field === "output" && part.data.tool === "bash"
              ? "output"
              : undefined;
      if (!field) return [...facts, ...this.notice(frame.data, type)];
      if (field !== "output") part.data.text = string(part.data.text) + string(p.delta);
      return [
        ...facts,
        {
          type: "item.delta",
          agent: this.key(part.agent),
          item: part.item,
          field,
          append: string(p.delta),
        },
        ...(s.active
          ? [
              {
                type: "activity" as const,
                agent,
                activity: field === "reasoning" ? ("thinking" as const) : ("responding" as const),
              },
            ]
          : []),
      ];
    }
    if (type === "permission.asked" || type === "question.asked") {
      const interaction = string(p.id);
      if (!interaction) return [...facts, ...this.notice(frame.data, type)];
      if (this.pending.has(interaction)) return facts;
      const call = string(object(p.tool).callID);
      const part = this.parts.get(call);
      const pending: Pending = {
        agent,
        ...(call ? { item: call } : {}),
        request: request(type, p, string(part?.data.tool), s.planPath),
      };
      this.pending.set(interaction, pending);
      facts.push({
        type: "interaction.opened",
        agent,
        interaction,
        blocking: true,
        request: pending.request,
        ...(call ? { item: call } : {}),
        raw: raw(type, frame.data),
      });
      if (call)
        facts.push({
          type: "item.upsert",
          agent,
          item: call,
          draft: { type: "tool_call", call: { status: "awaiting_approval" } },
        });
      return facts;
    }
    if (["permission.replied", "question.replied", "question.rejected"].includes(type)) {
      const interaction = string(p.requestID);
      const pending = this.pending.get(interaction);
      if (!pending) return [...facts, ...this.notice(frame.data, type)];
      this.pending.delete(interaction);
      return [
        ...facts,
        {
          type: "interaction.closed",
          interaction,
          state: "resolved",
          resolution: resolution(type, p, pending),
        },
      ];
    }
    if (type === "server.connected" || type === "server.heartbeat" || type === "session.idle")
      return facts;
    return [...facts, ...this.notice(frame.data, type || "unknown")];
  }
  private http(frame: Frame, data: Data, now: number): Fact[] {
    const path = string(data.path).split("?")[0]!;
    const body = object(data.body);
    if (
      frame.dir === "recv" &&
      data.method === "POST" &&
      path === "/session" &&
      typeof body.id === "string"
    )
      return this.seen(body);
    if (frame.dir === "recv" && path === "/mcp") {
      this.mcp = new Set(Object.keys(body));
      return [];
    }
    const match = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/.exec(path);
    if (match && frame.dir === "send") {
      const id = match[1]!;
      const s = this.session(id);
      if (match[2] === "abort") {
        s.abort = true;
        return [];
      }
      s.sent = true;
      if (typeof body.messageID === "string") this.own.add(body.messageID);
      return [{ type: "wake.expected", agent: this.key(id), until: Number.MAX_SAFE_INTEGER }];
    }
    if (frame.dir === "recv" && number(data.status) >= 400)
      return this.notice(frame.data, "HTTP error");
    void now;
    return this.notice(frame.data, `HTTP ${string(data.method)} ${path}`);
  }
  private part(p: Data, now: number): Fact[] {
    const id = string(p.sessionID);
    const agent = this.key(id);
    const s = this.session(id);
    const partId = string(p.id);
    if (!partId) return this.notice(p, "part without id");
    const item = p.type === "tool" ? string(p.callID, partId) : partId;
    const previous = this.parts.get(partId);
    const part: Part = { agent: id, data: p, item };
    this.parts.set(partId, part);
    if (p.type === "tool") this.parts.set(item, part);
    const facts: Fact[] = [];
    const message = this.messages.get(string(p.messageID));
    if (p.type === "text" || p.type === "reasoning") {
      const text = string(p.text);
      const user = message?.role === "user";
      if (user && this.own.has(string(p.messageID))) {
        const path = /[^\s<>]+\/\.opencode\/plans\/[^\s<>]+\.md/.exec(text)?.[0];
        if (path) s.planPath = path;
      }
      const task =
        user && !this.own.has(string(p.messageID)) && p.synthetic === true
          ? /^<task id="([^"]+)" state="(completed|error)">/.exec(text)
          : null;
      if (task && this.backgrounds.has(task[1]!)) {
        s.trigger = "subagent_result";
        facts.push(
          { type: "wake.expected", agent, until: Number.MAX_SAFE_INTEGER },
          {
            type: "background.ended",
            task: task[1]!,
            status: task[2] === "error" ? "failed" : "completed",
          },
        );
        this.backgrounds.delete(task[1]!);
      }
      facts.push({
        type: "item.upsert",
        agent,
        item,
        draft:
          p.type === "reasoning"
            ? {
                type: "reasoning",
                text,
                complete: typeof object(p.time).end === "number",
                summary: false,
                raw: raw("message.part.updated", p),
              }
            : {
                type: "message",
                role: user ? "user" : "assistant",
                parts: [{ type: "text", text }],
                complete: user || typeof object(p.time).end === "number",
                synthetic: p.synthetic === true,
                raw: raw("message.part.updated", p),
              },
      });
      if (!user && s.active)
        facts.push({
          type: "activity",
          agent,
          activity: p.type === "reasoning" ? "thinking" : "responding",
        });
    } else if (p.type === "tool") {
      const state = object(p.state);
      const meta = object(state.metadata);
      const input = object(state.input);
      const name = string(p.tool);
      const child = string(meta.sessionId);
      const d = detail(name, input, meta, this.mcp);
      let status = toolStatus(state, s.abort);
      if (
        [...this.pending.values()].some((v) => v.item === item) &&
        (status === "running" || status === "pending")
      )
        status = "awaiting_approval";
      facts.push({
        type: "item.upsert",
        agent,
        item,
        draft: {
          type: "tool_call",
          complete: !["pending", "running", "awaiting_approval"].includes(status),
          call: {
            kind: d.kind,
            title: string(state.title, name),
            status,
            detail: {
              ...d,
              ...(d.kind === "shell" ? { output: string(state.output, string(meta.output)) } : {}),
            },
            raw: raw("message.part.updated", p, name),
            ...(typeof state.error === "string" ? { error: state.error } : {}),
          },
        },
      });
      if (name === "task" && child) {
        facts.push({
          type: "agent.linked",
          agent: this.key(child),
          parent: agent,
          spawnedBy: item,
          background: meta.background === true,
        });
        if (
          meta.background === true &&
          !this.backgrounds.has(child) &&
          object(object(previous?.data.state).metadata).background !== true
        ) {
          this.backgrounds.set(child, { agent: id, child, item });
          facts.push({
            type: "background.started",
            agent,
            task: child,
            kind: "subagent",
            title: string(input.description, "Background subagent"),
            item,
            childAgent: this.key(child),
            stoppable: true,
            raw: raw("task", p, name),
          });
        }
      }
      const survivor = `survivor:${item}`;
      if (
        !["pending", "running", "awaiting_approval"].includes(status) &&
        this.backgrounds.has(survivor)
      ) {
        facts.push({
          type: "background.ended",
          task: survivor,
          status: status === "cancelled" ? "stopped" : status === "failed" ? "failed" : "completed",
        });
        this.backgrounds.delete(survivor);
      }
    } else if (p.type === "step-finish") {
      const tokens = object(p.tokens);
      facts.push({
        type: "usage",
        agent,
        inputTokens: number(tokens.input),
        outputTokens: number(tokens.output),
        cachedInputTokens: number(object(tokens.cache).read),
        costUsd: number(p.cost),
      });
    } else facts.push(...this.notice(p, string(p.type, "unknown part")));
    return facts;
  }
  tick(now: number): Fact[] {
    const facts: Fact[] = [];
    for (const [task, bg] of this.backgrounds)
      if (bg.child && bg.idleAt !== undefined && now >= bg.idleAt + 3_000) {
        facts.push({ type: "background.ended", task, status: "completed" });
        this.backgrounds.delete(task);
      }
    return facts;
  }
}
