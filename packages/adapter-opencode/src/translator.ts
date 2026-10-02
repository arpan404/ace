import type { Fact, Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { number, object, raw, string, retryReason, type Data } from "./data.ts";
import { request, resolution, type Pending } from "./interactions.ts";
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
    }
  }
  private frame(frame: Frame, now: number): Fact[] {
    const data = object(frame.data);
    if (frame.channel === "lifecycle") {
      if (data.type === "background.grace.expired") return this.tick(now);
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
        const facts: Fact[] = [...this.state.pending.keys()].map((interaction) => ({
          type: "interaction.closed",
          interaction,
          state: "expired",
        }));
        this.state.pending.clear();
        return facts;
      }
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
    if (type === "sync") return [{ type: "signal" }]; // Durable twin; never apply it twice.
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
      return [...facts, ...this.state.seen(object(p.info))];
    if (type === "session.status") {
      const status = object(p.status);
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
      facts.push({ type: "retry.cleared", agent });
      for (const bg of this.state.backgrounds.values()) if (bg.child === id) bg.idleAt = now;
      if (!s.active && s.user && s.turn !== s.user && this.state.answered.has(s.user)) {
        const aborted = s.abort;
        const error = s.error;
        facts.push(...this.state.start(id, s));
        s.abort = aborted;
        if (error) s.error = error;
      }
      if (!s.active) return facts;
      // A native idle does not prove that a running tool stopped, especially on abort.
      for (const partId of this.state.liveTools.get(id) ?? []) {
        const part = this.state.parts.get(partId);
        if (!part) continue;
        const state = object(part.data.state);
        if (
          part.agent !== id ||
          part.data.type !== "tool" ||
          !["pending", "running"].includes(string(state.status))
        )
          continue;
        if ([...this.state.backgrounds.values()].some((bg) => bg.item === part.item)) continue;
        const task = `survivor:${part.item}`;
        this.state.backgrounds.set(task, { agent: id, item: part.item });
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
      return [...facts, ...this.state.notice(frame.data, type)];
    }
    if (type === "message.updated") {
      const info = object(p.info);
      const msg = string(info.id);
      const previous = this.state.messages.get(msg);
      this.state.messages.set(msg, info);
      if (this.state.clockOffset === undefined && typeof object(info.time).created === "number")
        this.state.clockOffset = now - number(object(info.time).created);
      if (info.role === "user" && !previous) {
        s.user = msg;
        s.abort = false;
        delete s.error;
        s.trigger = this.state.own.has(msg) || s.sent ? "user" : "unknown";
        if (s.sent) {
          this.state.own.add(msg);
          s.sent = false;
        }
        if (s.status !== "idle") facts.push(...this.state.start(id, s));
        else if (!s.active)
          facts.push({ type: "wake.expected", agent, until: Number.MAX_SAFE_INTEGER });
      }
      if (info.role === "assistant") {
        if (typeof info.parentID === "string" && typeof object(info.time).completed === "number")
          this.state.answered.add(info.parentID);
        if (!s.user && typeof info.parentID === "string") {
          s.user = info.parentID;
          if (s.status !== "idle") facts.push(...this.state.start(id, s));
        }
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
    if (type === "message.part.updated")
      return [...facts, ...translatePart(this.state, object(p.part))];
    if (type === "message.part.delta") {
      const part = this.state.parts.get(string(p.partID));
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
      if (field !== "output") part.data.text = string(part.data.text) + string(p.delta);
      return [
        ...facts,
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
    if (type === "permission.asked" || type === "question.asked") {
      const interaction = string(p.id);
      if (!interaction) return [...facts, ...this.state.notice(frame.data, type)];
      if (this.state.pending.has(interaction)) return facts;
      const call = string(object(p.tool).callID);
      const part = this.state.parts.get(call);
      const pending: Pending = {
        agent,
        ...(call ? { item: call } : {}),
        request: request(type, p, string(part?.data.tool), s.planPath, s.planMarkdown),
      };
      this.state.pending.set(interaction, pending);
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
      const pending = this.state.pending.get(interaction);
      if (!pending) return [...facts, ...this.state.notice(frame.data, type)];
      this.state.pending.delete(interaction);
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
    return [...facts, ...this.state.notice(frame.data, type || "unknown")];
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
      return this.state.seen(body);
    if (frame.dir === "recv" && path === "/mcp") {
      this.state.mcp = new Set(Object.keys(body));
      return [];
    }
    const match = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/.exec(path);
    if (match && frame.dir === "send") {
      const id = string(match[1]);
      const s = this.state.session(id);
      if (match[2] === "abort") {
        s.abort = true;
        return [];
      }
      s.sent = true;
      if (typeof body.messageID === "string") this.state.own.add(body.messageID);
      return [{ type: "wake.expected", agent: this.state.key(id), until: Number.MAX_SAFE_INTEGER }];
    }
    if (frame.dir === "recv" && number(data.status) >= 400)
      return this.state.notice(frame.data, "HTTP error");
    return this.state.notice(frame.data, `HTTP ${string(data.method)} ${path}`);
  }
  tick(now: number): Fact[] {
    const facts: Fact[] = [];
    for (const [task, bg] of this.state.backgrounds)
      if (bg.child && bg.idleAt !== undefined && now >= bg.idleAt + 3_000) {
        facts.push({ type: "background.ended", task, status: "completed" });
        this.state.backgrounds.delete(task);
      }
    return facts;
  }
}
