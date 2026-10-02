import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Key } from "@ace/core";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import type { Frame, ProviderSession, SessionContext } from "./contract.ts";
import { array, object, string } from "./data.ts";
import { OpenCodeServer, eventSession } from "./server.ts";
type Queued = { input: ContentPart[]; resolve(): void; reject(error: Error): void };
export class OpenCodeSession implements ProviderSession {
  readonly nativeSessionId: string;
  private ctx: SessionContext;
  private server: OpenCodeServer;
  private controller = new AbortController();
  private sequence = 0;
  private startedAt = performance.now();
  private known = new Set<string>();
  private parents = new Map<string, string>();
  private busy = new Set<string>();
  private backgrounds = new Set<string>();
  private questions = new Map<string, unknown>();
  private queue: Queued[] = [];
  private pendingPrompt = false;
  private unsubscribe: () => void = () => {};
  private opening = true;
  private buffer: unknown[] = [];
  private closed = false;
  private abortListener: () => void;
  private pumping = false;
  private constructor(ctx: SessionContext, server: OpenCodeServer, id: string) {
    this.ctx = ctx;
    this.server = server;
    this.nativeSessionId = id;
    this.known.add(id);
    this.abortListener = () => {
      void this.close("shutdown");
    };
  }
  static async open(ctx: SessionContext, server: OpenCodeServer): Promise<OpenCodeSession> {
    ctx.signal.throwIfAborted();
    await server.ready();
    const session = new OpenCodeSession(ctx, server, ctx.resume?.nativeSessionId ?? "");
    // Subscribe before creation so early session/child announcements cannot be lost.
    session.unsubscribe = server.subscribe({
      receive: (data) => session.receive(data),
      disconnected: () => session.emit("note", "lifecycle", { type: "disconnected" }),
      resync: () => session.resync(),
      exited: (deliberate, message) => {
        if (!session.closed) {
          session.emit("note", "lifecycle", { type: "exited", deliberate, message });
          ctx.onExit({ deliberate, ...(message ? { message } : {}) });
        }
      },
    });
    ctx.signal.addEventListener("abort", session.abortListener, { once: true });
    try {
      session.emit("note", "lifecycle", { type: "started" });
      if (!ctx.resume) {
        const info = object(await session.request("POST", "/session", { title: "ace" }));
        const id = string(info.id);
        if (!id) throw new Error("OpenCode did not return a session id");
        Object.defineProperty(session, "nativeSessionId", { value: id });
        session.known.clear();
        session.known.add(id);
      }
      session.opening = false;
      for (const data of session.buffer.splice(0)) session.receive(data);
      if (ctx.resume) await session.resync();
      if (ctx.signal.aborted) {
        await session.close("shutdown");
        ctx.signal.throwIfAborted();
      }
      return session;
    } catch (error) {
      await session.close("shutdown");
      throw error;
    }
  }
  private emit = (dir: Frame["dir"], channel: string, data: unknown): void => {
    this.ctx.onFrame({
      seq: this.sequence++,
      t: Math.round(performance.now() - this.startedAt),
      dir,
      channel,
      data,
    });
  };
  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.server.request(method, path, this.ctx.cwd, body, this.emit, this.controller.signal);
  }
  private receive(data: unknown): void {
    if (this.closed) return;
    if (this.opening) {
      this.buffer.push(data);
      return;
    }
    const envelope = object(data);
    const payload = object(envelope.payload);
    const p = object(payload.properties);
    const info = object(p.info);
    const id = eventSession(data) || string(info.id);
    if (payload.type === "session.created" && this.known.has(string(info.parentID))) {
      this.known.add(string(info.id));
      this.parents.set(string(info.id), string(info.parentID));
    }
    if (id && !this.known.has(id)) return;
    if (
      typeof envelope.directory === "string" &&
      envelope.directory !== this.ctx.cwd &&
      envelope.directory !== "global"
    )
      return;
    this.emit("recv", "sse", data);
    if (payload.type === "session.status") {
      if (object(p.status).type === "idle") this.busy.delete(id);
      else {
        this.busy.add(id);
        if (id === this.nativeSessionId) this.pendingPrompt = false;
      }
    }
    if (payload.type === "question.asked" || payload.type === "permission.asked")
      this.questions.set(string(p.id), p);
    if (
      ["question.replied", "question.rejected", "permission.replied"].includes(string(payload.type))
    )
      this.questions.delete(string(p.requestID));
    const part = object(p.part);
    const meta = object(object(part.state).metadata);
    if (part.tool === "task" && meta.background === true && typeof meta.sessionId === "string")
      this.backgrounds.add(meta.sessionId);
    if (part.type === "text" && part.synthetic === true) {
      const task = /^<task id="([^"]+)" state="(completed|error)">/.exec(string(part.text));
      if (task) {
        this.backgrounds.delete(task[1]!);
        this.pendingPrompt = true;
      }
    }
    void this.pump();
  }
  async send(input: ContentPart[], delivery: "steer" | "queue"): Promise<void> {
    if (this.closed) throw new Error("OpenCode session is closed");
    if (delivery === "steer")
      throw new Error("OpenCode does not support native steering; use queue delivery");
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      void this.pump();
    });
  }
  private async pump(): Promise<void> {
    if (
      this.pumping ||
      this.closed ||
      this.pendingPrompt ||
      this.busy.size ||
      this.backgrounds.size ||
      this.questions.size
    )
      return;
    const next = this.queue.shift();
    if (!next) return;
    this.pumping = true;
    this.pendingPrompt = true;
    try {
      const parts = next.input.map((part) =>
        part.type === "text"
          ? part
          : part.type === "image"
            ? { type: "file", mime: part.mimeType, url: part.url }
            : {
                type: "file",
                mime: part.mimeType ?? "text/plain",
                url: pathToFileURL(part.path).href,
              },
      );
      const slash = this.ctx.model?.indexOf("/") ?? -1;
      await this.request("POST", `/session/${this.nativeSessionId}/prompt_async`, {
        messageID: `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`,
        parts,
        ...(slash > 0
          ? {
              model: {
                providerID: this.ctx.model!.slice(0, slash),
                modelID: this.ctx.model!.slice(slash + 1),
              },
            }
          : {}),
      });
      next.resolve();
    } catch (error) {
      this.pendingPrompt = false;
      next.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pumping = false;
      void this.pump();
    }
  }
  async interrupt(target: { agent?: Key; cascade: boolean }): Promise<void> {
    const id = target.agent && this.known.has(target.agent) ? target.agent : this.nativeSessionId;
    const descendants = (parent: string): string[] =>
      [...this.parents]
        .filter(([, p]) => p === parent)
        .flatMap(([child]) => [...descendants(child), child]);
    for (const child of target.cascade ? descendants(id) : [])
      await this.request("POST", `/session/${child}/abort`, {});
    await this.request("POST", `/session/${id}/abort`, {});
  }
  async resolve(interaction: Key, resolution: InteractionResolution): Promise<void> {
    if (resolution.kind === "approval") {
      if (!["once", "always", "reject"].includes(resolution.optionId))
        throw new Error("Unsupported OpenCode approval option");
      await this.request("POST", `/permission/${encodeURIComponent(interaction)}/reply`, {
        reply: resolution.optionId,
        ...(resolution.message ? { message: resolution.message } : {}),
      });
    } else if (resolution.kind === "question") {
      if (resolution.dismissed)
        await this.request("POST", `/question/${encodeURIComponent(interaction)}/reject`, {});
      else {
        const pending = object(this.questions.get(interaction));
        const questions = array(pending.questions);
        if (!questions.length) throw new Error("OpenCode question is no longer pending");
        await this.request("POST", `/question/${encodeURIComponent(interaction)}/reply`, {
          answers: questions.map((_, i) => resolution.answers[`${interaction}#${i}`] ?? []),
        });
      }
    } else if (resolution.kind === "plan_review")
      await this.request(
        "POST",
        `/question/${encodeURIComponent(interaction)}/${resolution.decision === "approve" ? "reply" : "reject"}`,
        resolution.decision === "approve" ? { answers: [["Yes"]] } : {},
      );
    else throw new Error("OpenCode does not support elicitation resolution");
  }
  async stopTask(task: Key): Promise<void> {
    const id = task.startsWith("survivor:") ? this.nativeSessionId : task;
    if (!this.known.has(id)) throw new Error("Unknown OpenCode task");
    await this.interrupt({ agent: id, cascade: true });
  }
  async resync(): Promise<void> {
    if (this.closed || this.opening) return;
    this.questions.clear();
    const visit = async (id: string): Promise<void> => {
      const info = await this.request("GET", `/session/${id}`);
      this.receive({
        directory: this.ctx.cwd,
        payload: { type: "session.created", properties: { info, sessionID: id } },
      });
      for (const child of array(await this.request("GET", `/session/${id}/children`))) {
        const c = object(child);
        if (typeof c.id === "string") {
          this.known.add(c.id);
          this.parents.set(c.id, id);
          await visit(c.id);
        }
      }
      for (const message of array(await this.request("GET", `/session/${id}/message`))) {
        const m = object(message);
        this.receive({
          payload: { type: "message.updated", properties: { sessionID: id, info: m.info } },
        });
        for (const part of array(m.parts))
          this.receive({
            payload: { type: "message.part.updated", properties: { sessionID: id, part } },
          });
      }
    };
    await visit(this.nativeSessionId);
    for (const path of ["/permission", "/question"])
      for (const p of array(await this.request("GET", path)))
        this.receive({
          payload: {
            type: path === "/permission" ? "permission.asked" : "question.asked",
            properties: p,
          },
        });
    const statuses = object(await this.request("GET", "/session/status"));
    for (const id of this.known)
      this.receive({
        payload: {
          type: "session.status",
          properties: { sessionID: id, status: statuses[id] ?? { type: "idle" } },
        },
      });
  }
  async close(_reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.unsubscribe();
    this.ctx.signal.removeEventListener("abort", this.abortListener);
    for (const q of this.queue.splice(0)) q.reject(new Error("OpenCode session closed"));
    this.emit("note", "lifecycle", { type: "exited", deliberate: true });
    this.ctx.onExit({ deliberate: true });
  }
}
