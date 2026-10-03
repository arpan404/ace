import { redactMcpCredential, developerInstructions } from "@ace/mcp-server";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Key } from "@ace/core";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import { nativeResolution } from "./interactions.ts";
import { SnapshotWatermarks } from "./watermarks.ts";
import { HistoryReader } from "./history.ts";
import { OpenCodeTranslator } from "./translator.ts";
import { messageId, promptBody } from "./input.ts";
import { array, object, string } from "./data.ts";
import { OpenCodeServer, eventSession } from "./server.ts";
type Queued = { input: ContentPart[]; resolve(): void; reject(error: Error): void };
export class OpenCodeSession implements ProviderSession {
  private nativeId: string;
  private project = "";
  get nativeSessionId(): string {
    return this.nativeId;
  }
  private reportedExit = false;
  private resynchronizing = false;
  private disconnected = false;
  private graceDeadline: number | undefined;
  private cancelGrace: (() => void) | undefined;
  private translator: OpenCodeTranslator;
  private ctx: SessionContext;
  private server: OpenCodeServer;
  private controller = new AbortController();
  private sequence = 0;
  private startedAt: number;
  private known = new Set<string>();
  private watermarks = new SnapshotWatermarks();
  private history: HistoryReader;
  private promptSequence = 0;
  private parents = new Map<string, string>();

  private questions = new Map<string, unknown>();
  private queue: Queued[] = [];

  private unsubscribe: () => void = () => {};
  private opening = true;
  private buffer: unknown[] = [];
  private closed = false;
  private abortListener: () => void;
  private pumping = false;
  private constructor(ctx: SessionContext, server: OpenCodeServer, id: string) {
    this.ctx = ctx;
    this.startedAt = server.runtime.monotonic();
    this.translator = new OpenCodeTranslator({
      threadId: ctx.threadId,
      rootKey: ctx.rootKey ?? "root",
    });
    this.server = server;
    this.history = new HistoryReader(
      server,
      ctx.cwd,
      this.emit,
      this.controller.signal,
      (data, started) => this.snapshot(data, started),
    );
    this.nativeId = id;
    this.known.add(id);
    this.abortListener = () => {
      void this.close("shutdown").catch(() => {});
    };
  }
  static async open(ctx: SessionContext, server: OpenCodeServer): Promise<OpenCodeSession> {
    ctx.signal.throwIfAborted();
    await server.ready();
    if (ctx.signal.aborted) {
      await server.release();
      ctx.signal.throwIfAborted();
    }
    const session = new OpenCodeSession(ctx, server, ctx.resume?.nativeSessionId ?? "");
    // Subscribe before creation so early session/child announcements cannot be lost.
    session.unsubscribe = server.subscribe({
      accepts: (data, watermark) => {
        if (!session.owns(data)) return false;
        session.watermarks.observe(data, watermark);
        return true;
      },
      receive: (data) => session.receive(data),
      frame: session.emit,
      disconnected: () => {
        session.disconnected = true;
        session.emit("note", "lifecycle", { type: "disconnected", transport: "lost" });
      },
      buffered: (data) => {
        if (!session.owns(data)) return false;
        session.emit("recv", "sse.buffered", data);
        return !["server.connected", "server.heartbeat"].includes(
          string(object(object(data).payload).type),
        );
      },
      reconcile: (data, watermark) => {
        if (!session.owns(data)) return;
        const payload = object(object(data).payload);
        const type = string(payload.type);
        if (
          !session.watermarks.isLatest(data, watermark) ||
          session.watermarks.covers(data, watermark)
        )
          return;
        if (
          type === "session.status" ||
          type === "session.error" ||
          type === "session.created" ||
          type.startsWith("permission.") ||
          type.startsWith("question.") ||
          (type === "message.part.updated" &&
            object(object(payload.properties).part).type === "tool")
        )
          session.receive(data);
      },
      recovered: () => {
        session.disconnected = false;
        session.emit("note", "lifecycle", { type: "resynced", transport: "restored" });
        void session.pump();
      },
      resync: () => session.resync(),
      finalizeSnapshots: () => session.finalizeSnapshots(),
      exited: (deliberate, message) => {
        if (!session.closed && !session.reportedExit) {
          session.reportedExit = true;
          session.emit("note", "lifecycle", { type: "exited", deliberate, message });
          ctx.onExit({ deliberate, ...(message ? { message } : {}) });
          void session.close("shutdown").catch(() => {});
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
        session.nativeId = id;
        session.project = string(info.projectID);
        session.known.clear();
        session.known.add(id);
      }
      session.opening = false;
      for (const data of session.buffer.splice(0)) session.receive(data);
      await session.request("GET", "/mcp");
      if (ctx.resume) {
        await session.resync();
        session.finalizeSnapshots();
      }
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
    const t = Math.round(this.server.runtime.monotonic() - this.startedAt);
    const clockPayload = new ProviderPayload(
      JSON.stringify({ wallTime: this.server.runtime.wallTime() }),
    );
    const clock: Frame = {
      seq: this.sequence++,
      t,
      dir: "note",
      channel: "clock",
      data: clockPayload.data,
      payload: clockPayload,
    };
    this.translator.translate(clock, t);
    this.ctx.onFrame(clock);
    const payload = new ProviderPayload(redactMcpCredential(JSON.stringify(data), this.ctx.aceMcp));
    const frame: Frame = { seq: this.sequence++, t, dir, channel, data: payload.data, payload };
    this.translator.translate(frame, t);
    this.ctx.onFrame(frame);
  };
  private snapshot(data: unknown, started: number): void {
    if (this.watermarks.stage(data, started)) this.receive(data);
    else this.emit("recv", "snapshot.deferred", data);
  }
  private finalizeSnapshots(): void {
    for (const data of this.watermarks.flush()) this.receive(data);
  }
  private owns(data: unknown): boolean {
    const envelope = object(data);
    if (
      typeof envelope.directory === "string" &&
      envelope.directory !== this.ctx.cwd &&
      envelope.directory !== "global"
    )
      return false;
    if (this.project && typeof envelope.project === "string" && envelope.project !== this.project)
      return false;
    const payload = object(envelope.payload);
    const info = object(object(payload.properties).info);
    const id = eventSession(data) || string(info.id);
    if (!this.project && id === this.nativeSessionId) this.project = string(info.projectID);
    if (payload.type === "session.created" && this.known.has(string(info.parentID))) {
      this.known.add(string(info.id));
      this.parents.set(string(info.id), string(info.parentID));
    }
    return !id || this.known.has(id);
  }
  private armGrace(): void {
    const deadline = this.translator.nextDeadline();
    if (deadline === this.graceDeadline) return;
    this.graceDeadline = deadline;
    this.cancelGrace?.();
    if (deadline === undefined) {
      this.cancelGrace = undefined;
      return;
    }
    this.cancelGrace = this.server.runtime.schedule(
      () => {
        this.cancelGrace = undefined;
        this.graceDeadline = undefined;
        this.emit("note", "lifecycle", { type: "background.grace.expired" });
        this.armGrace();
        void this.pump();
      },
      Math.max(0, deadline - (this.server.runtime.monotonic() - this.startedAt)),
    );
  }
  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.server
      .request(method, path, this.ctx.cwd, body, this.emit, this.controller.signal)
      .catch((error: unknown) => {
        this.emit("note", "transport", {
          type: "request.failed",
          method,
          path,
          messageID: object(body).messageID,
          message: String(error),
        });
        throw error;
      });
  }
  private receive(data: unknown): void {
    if (this.closed) return;
    if (this.opening) {
      this.buffer.push(data);
      return;
    }
    if (!this.owns(data)) return;
    const payload = object(object(data).payload);
    const p = object(payload.properties);
    this.emit("recv", "sse", data);
    if (payload.type === "question.asked" || payload.type === "permission.asked")
      this.questions.set(string(p.id), p);
    if (
      ["question.replied", "question.rejected", "permission.replied"].includes(string(payload.type))
    )
      this.questions.delete(string(p.requestID));
    this.armGrace();
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
      this.disconnected ||
      this.resynchronizing ||
      this.pumping ||
      this.closed ||
      !this.translator.isSettled()
    )
      return;
    const next = this.queue.shift();
    if (!next) return;
    this.pumping = true;
    try {
      await this.request("POST", `/session/${this.nativeSessionId}/prompt_async`, {
        ...promptBody(
          next.input,
          this.ctx.cwd,
          messageId(
            this.server.runtime.wallTime(),
            ++this.promptSequence,
            this.server.runtime.entropy(7),
          ),
          this.ctx.model,
        ),
        ...(this.ctx.aceMcp ? { system: developerInstructions("opencode") } : {}),
      });
      next.resolve();
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pumping = false;
      void this.pump();
    }
  }
  async interrupt(target: { agent?: Key; cascade: boolean }): Promise<void> {
    const id =
      target.agent && target.agent !== this.ctx.rootKey && this.known.has(target.agent)
        ? target.agent
        : this.nativeSessionId;
    await this.abortNative(id, target.cascade);
  }
  private async abortNative(id: string, cascade: boolean): Promise<void> {
    const visited = new Set<string>();
    const descendants = (parent: string): string[] =>
      [...this.parents]
        .filter(([child, p]) => p === parent && child !== id && !visited.has(child))
        .flatMap(([child]) => {
          visited.add(child);
          return descendants(child).concat(child);
        });
    for (const child of cascade ? descendants(id) : [])
      await this.request("POST", `/session/${child}/abort`, {});
    await this.request("POST", `/session/${id}/abort`, {});
  }
  async resolve(interaction: Key, resolution: InteractionResolution): Promise<void> {
    const command = nativeResolution(interaction, resolution, this.questions.get(interaction));
    await this.request("POST", command.path, command.body);
  }
  async stopTask(task: Key): Promise<void> {
    const id = task.startsWith("survivor:") ? this.translator.taskOwner(task) : task;
    if (!id || !this.known.has(id)) throw new Error("Unknown OpenCode task");
    await this.abortNative(id, true);
  }
  async resync(): Promise<void> {
    if (this.closed || this.opening) return;
    this.resynchronizing = true;
    this.questions.clear();
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      const started = this.server.eventWatermark;
      const info = await this.request("GET", `/session/${id}`);
      this.snapshot(
        {
          directory: this.ctx.cwd,
          payload: { type: "session.created", properties: { info, sessionID: id } },
        },
        started,
      );
      for (const child of array(await this.request("GET", `/session/${id}/children`))) {
        const c = object(child);
        if (typeof c.id === "string") {
          this.known.add(c.id);
          this.parents.set(c.id, id);
          await visit(c.id);
        }
      }
      await this.history.read(id);
    };
    await visit(this.nativeSessionId);
    for (const path of ["/permission", "/question"]) {
      const started = this.server.eventWatermark;
      const pending = await this.request("GET", path);
      this.watermarks.category(path.slice(1), started);
      for (const p of array(pending))
        this.snapshot(
          {
            payload: {
              type: path === "/permission" ? "permission.asked" : "question.asked",
              properties: p,
            },
          },
          started,
        );
    }
    const started = this.server.eventWatermark;
    const statuses = object(await this.request("GET", "/session/status"));
    for (const id of this.known)
      this.snapshot(
        {
          payload: {
            type: "session.status",
            properties: { sessionID: id, status: statuses[id] ?? { type: "idle" } },
          },
        },
        started,
      );
    this.resynchronizing = false;
    void this.pump();
  }
  async close(reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (this.closed) return;
    const unsettled = !this.translator.isSettled();
    if (reason === "idle" && unsettled)
      throw new Error("Cannot idle-close an unsettled OpenCode session");
    const abortProvider = reason !== "idle" && unsettled && !this.reportedExit;
    this.closed = true;
    // Local cancellation cannot depend on the provider accepting an abort.
    this.controller.abort();
    this.cancelGrace?.();
    this.unsubscribe();
    this.ctx.signal.removeEventListener("abort", this.abortListener);
    for (const q of this.queue.splice(0)) q.reject(new Error("OpenCode session closed"));
    if (!this.reportedExit) {
      this.reportedExit = true;
      this.emit("note", "lifecycle", { type: "exited", deliberate: true });
      this.ctx.onExit({ deliberate: true });
    }
    const abort = new AbortController();
    const cancel = this.server.runtime.schedule(() => abort.abort(), this.server.shutdownTimeoutMs);
    try {
      if (abortProvider) {
        for (const id of [...this.known].toReversed())
          await this.server.request(
            "POST",
            `/session/${id}/abort`,
            this.ctx.cwd,
            {},
            () => {},
            abort.signal,
          );
      }
    } catch {
      /* Process teardown owns cancellation if abort fails or times out. */
    } finally {
      cancel();
      await this.server.release();
    }
  }
}
