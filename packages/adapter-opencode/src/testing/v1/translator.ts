import type { Fact, Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { number, object, string, retryReason, type Data } from "./data.ts";
import { translateInteraction } from "./interactions.ts";
import { translatePart } from "./parts.ts";
import { TranslationState } from "./translation-state.ts";

/** v1 HTTP + global SSE translator. */
export class OpenCodeTranslator implements Translator {
  private state: TranslationState;
  constructor(init: { threadId: ThreadId; rootKey: Key }) {
    this.state = new TranslationState(init);
  }
  translate(frame: Frame, now: number): Fact[] {
    // Provider frames are JSON. Invalid shapes remain available as raw notices.
    try {
      return this.frame(frame, now);
    } catch {
      return this.state.notice(frame.data, "malformed frame");
    } finally {
      this.state.refresh();
    }
  }
  private frame(frame: Frame, now: number): Fact[] {
    const data = object(frame.data);
    if (frame.channel === "lifecycle") {
      if (data.type === "background.grace.expired") return this.tick(now);
      if (data.type === "started")
        return [
          { type: "process.started" },
          ...this.state.metadata("process.started", "process", frame.data),
        ];
      if (data.type === "exited")
        return [
          ...this.state.metadata("process.exited", "process", frame.data),
          {
            type: "process.exited",
            deliberate: data.deliberate === true,
            message: string(data.message),
          },
        ];
      if (data.type === "disconnected") {
        this.state.disconnected = true;
        const facts: Fact[] = [...this.state.pending.keys()].map((interaction) => ({
          type: "interaction.closed",
          interaction,
          state: "expired",
        }));
        this.state.pending.clear();
        return [
          ...facts,
          ...this.transportFacts("agent.disconnected"),
          ...this.state.metadata("transport.lost", "stream", frame.data),
        ];
      }
      if (data.type === "resynced") {
        this.state.disconnected = false;
        return [
          ...this.transportFacts("agent.reconnected"),
          ...this.state.metadata("transport.restored", "stream", frame.data),
        ];
      }
      return [];
    }
    if (frame.channel === "clock") {
      if (typeof data.wallTime === "number") this.state.clockOffset = now - data.wallTime;
      return [];
    }
    if (frame.channel === "http") return this.http(frame, data);
    if (frame.channel === "transport" && data.type === "request.failed") {
      const match = /^\/session\/([^/]+)\/prompt_async$/.exec(string(data.path));
      if (match) {
        const id = string(match[1]);
        const s = this.state.session(id);
        const turn = string(data.messageID, `failed-send:${frame.seq}`);
        s.sent = false;
        s.awaiting = false;
        return [
          { type: "turn.started", agent: this.state.key(id), nativeTurnId: turn, trigger: "user" },
          {
            type: "turn.ended",
            agent: this.state.key(id),
            nativeTurnId: turn,
            outcome: "failed",
            error: { kind: "network", message: string(data.message, "Prompt delivery failed") },
          },
          ...this.state.notice(frame.data, "request.failed"),
        ];
      }
    }
    if (frame.channel !== "sse") return this.state.notice(frame.data, frame.channel);
    const payload = object(data.payload ?? data);
    const type = string(payload.type);
    if (type === "sync")
      return [{ type: "signal" }, ...this.state.metadata(type, "stream", frame.data)]; // Durable twin; never apply it twice.
    const eventId = string(payload.id);
    if (eventId && this.state.seenEvents.has(eventId)) return [{ type: "signal" }];
    if (eventId) {
      this.state.seenEvents.add(eventId);
      if (this.state.seenEvents.size > 10_000) {
        const first = this.state.seenEvents.values().next().value;
        if (first !== undefined) this.state.seenEvents.delete(first);
      }
    }
    const p = object(payload.properties);
    const id = string(
      p.sessionID,
      string(object(p.info).sessionID, string(object(p.part).sessionID)),
    );
    const facts: Fact[] = [{ type: "signal" }];
    const agent = this.state.key(id);
    const s = this.state.session(id);
    if (type === "session.created" || type === "session.updated")
      return [
        ...facts,
        ...this.state.seen(object(p.info)),
        ...this.state.metadata(type, string(object(p.info).id), frame.data),
      ];
    if (type === "session.status") {
      const status = object(p.status);
      facts.push(...this.state.metadata(type, id, frame.data));
      if (status.type === "busy" || status.type === "retry") this.state.backgrounds.resumed(id);
      if (status.type === "retry") {
        s.status = "retry";
        s.retrying = true;
        return [
          ...facts,
          {
            type: "retry",
            agent,
            on: retryReason(string(status.message)),
            attempt: number(status.attempt, 1),
            until: number(status.next) + (this.state.clockOffset ?? 0),
            message: string(status.message),
          },
        ];
      }
      if (status.type === "busy") {
        s.status = "busy";
        facts.push({ type: "retry.cleared", agent });
        facts.push(...this.state.start(id, s));
        if (s.active && s.retrying && !s.hasParts)
          facts.push({ type: "activity", agent, activity: "retrying" });
        return facts;
      }
      if (status.type !== "idle") return [...facts, ...this.state.notice(frame.data, type)];
      s.status = "idle";
      this.state.settleParts(id);
      facts.push({ type: "retry.cleared", agent });
      this.state.backgrounds.idle(id, now);
      if (!s.active && s.user && s.turn !== s.user && (s.error || s.abort || s.answered)) {
        const aborted = s.abort;
        const error = s.error;
        facts.push(...this.state.start(id, s));
        s.abort = aborted;
        if (error) s.error = error;
      }
      if (!s.active) return facts;
      // A native idle does not prove that a running tool stopped, especially on abort.
      for (const partId of this.state.liveTools.get(id) ?? []) {
        const part = this.state.getPart(partId);
        if (!part) continue;
        const state = object(part.data.state);
        if (
          part.agent !== id ||
          part.data.type !== "tool" ||
          !["pending", "running"].includes(string(state.status))
        )
          continue;
        facts.push(...this.state.survivor(id, part.item, part.data));
      }
      s.active = false;
      s.awaiting = false;
      s.sent = false;
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
      return [...facts, ...this.state.notice(frame.data, type)];
    }
    if (type === "message.updated") {
      const info = object(p.info);
      const msg = string(info.id);
      const previous = this.state.messages.get(msg);
      this.state.messages.set(msg, { role: info.role, parentID: info.parentID });
      facts.push(...this.state.metadata(type, msg, frame.data));
      const created = number(object(info.time).created);
      const historicalOlder =
        p.historical === true &&
        s.user !== undefined &&
        (created && s.userOrder ? created < s.userOrder : msg <= s.user);
      if (info.role === "user" && !previous && !historicalOlder) {
        const sameUser = s.user === msg;
        s.user = msg;
        s.userOrder = created;
        s.answered = false;
        s.awaiting = true;
        s.abort = false;
        delete s.error;
        s.trigger = this.state.own.has(msg) || s.sent ? "user" : sameUser ? s.trigger : "unknown";
        if (s.sent) {
          this.state.own.add(msg);
          s.sent = false;
        }
        if (s.status !== "idle") facts.push(...this.state.start(id, s));
        else if (!s.active)
          facts.push({ type: "wake.expected", agent, until: Number.MAX_SAFE_INTEGER });
      }
      if (info.role === "assistant") {
        if (info.parentID === s.user && typeof object(info.time).completed === "number")
          s.answered = true;
        if (!s.user && typeof info.parentID === "string") {
          s.user = info.parentID;
          if (s.status !== "idle") facts.push(...this.state.start(id, s));
        }
        if (info.error && (p.historical !== true || info.parentID === s.user)) {
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
    if (type === "message.part.updated") {
      const part = object(p.part);
      if (!string(part.id)) return [...facts, ...this.state.notice(frame.data, "part without id")];
      // The native part remains directly available in raw; retain its envelope's
      // fields separately so transcript/input bodies are not copied twice.
      const envelope = {
        ...(data.payload === undefined ? {} : data),
        payload: { ...payload, properties: { ...p } },
      };
      delete envelope.payload.properties.part;
      return [...facts, ...translatePart(this.state, part, envelope)];
    }
    if (type === "message.part.delta") {
      const part = this.state.getPart(string(p.partID));
      if (!part) return [...facts, ...this.state.notice(frame.data, type)];
      const field =
        part.data.type === "reasoning"
          ? "reasoning"
          : part.data.type === "text"
            ? "text"
            : p.field === "output" && part.data.tool === "bash"
              ? "output"
              : undefined;
      if (!field) return [...facts, ...this.state.notice(frame.data, type)];

      return [
        ...facts,
        ...this.state.metadata(type, part.item, frame.data),
        {
          type: "item.delta",
          agent: this.state.key(part.agent),
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
    if (type.startsWith("permission.") || type.startsWith("question."))
      return [...facts, ...translateInteraction(this.state, type, p, frame.data)];
    if (type === "server.connected" || type === "server.heartbeat" || type === "session.idle")
      return [...facts, ...this.state.metadata(type, id || "stream", frame.data)];
    return [...facts, ...this.state.notice(frame.data, type || "unknown")];
  }
  private transportFacts(type: "agent.disconnected" | "agent.reconnected"): Fact[] {
    const agents = new Set([this.state.rootKey]);
    for (const id of this.state.sessions.keys()) if (id) agents.add(this.state.key(id));
    return [...agents].map((agent) => ({ type, agent }));
  }
  private http(frame: Frame, data: Data): Fact[] {
    const path = string(data.path).split("?")[0] ?? "";
    const body = object(data.body);
    if (
      frame.dir === "recv" &&
      data.method === "POST" &&
      path === "/session" &&
      typeof body.id === "string"
    )
      return [
        ...this.state.seen(body),
        ...this.state.metadata("session.created", string(body.id), frame.data),
      ];
    if (frame.dir === "recv" && path === "/mcp") {
      this.state.mcp = new Set(Object.keys(body));
      return this.state.metadata("mcp", "servers", frame.data);
    }
    const match = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/.exec(path);
    if (match && frame.dir === "send" && data.method === "POST") {
      const id = string(match[1]);
      const s = this.state.session(id);
      if (match[2] === "abort") {
        s.abort = true;
        return this.state.metadata("abort", id, frame.data);
      }
      s.sent = true;
      s.awaiting = true;
      if (typeof body.messageID === "string") {
        this.state.own.add(body.messageID);
        s.user = body.messageID;
        s.trigger = "user";
      }
      return [
        { type: "wake.expected", agent: this.state.key(id), until: Number.MAX_SAFE_INTEGER },
        ...this.state.metadata("prompt", string(body.messageID, id), frame.data),
      ];
    }
    if (frame.dir === "recv" && number(data.status) >= 400)
      return this.state.notice(frame.data, "HTTP error");
    return this.state.notice(frame.data, `HTTP ${string(data.method)} ${path}`);
  }
  taskOwner(task: string): string | undefined {
    const bg = this.state.backgrounds.get(task);
    return bg?.child ?? bg?.agent;
  }
  isSettled(): boolean {
    return this.state.settled();
  }
  nextGraceDeadline(): number | undefined {
    return this.nextDeadline();
  }
  nextDeadline(): number | undefined {
    return this.state.graceDeadline;
  }
  tick(now: number): Fact[] {
    const facts: Fact[] = [];
    for (const [task, bg] of this.state.backgrounds.due(now))
      if (
        bg.child &&
        bg.idleAt !== undefined &&
        this.state.session(bg.child).status === "idle" &&
        now >= bg.idleAt + 3_000
      ) {
        facts.push({ type: "background.ended", task, status: "completed" });
        this.state.backgrounds.delete(task);
      }
    this.state.refresh();
    return facts;
  }
}
