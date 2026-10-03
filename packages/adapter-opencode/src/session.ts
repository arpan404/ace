import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Key } from "@ace/core";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import type { OpenCodeClient } from "@opencode/client";
import { NativeEvent, SessionInfo, eventSession } from "./boundaries.ts";
import { object, string } from "./data.ts";
import { recoverSessions } from "./recovery.ts";
import { HistoryReader } from "./history.ts";
import { OpenCodeTranslator } from "./translator.ts";
import { nativeResolution } from "./interactions.ts";
import { promptBody, messageId, selectedModel } from "./input.ts";
import { OpenCodeServer } from "./server.ts";
import { z } from "zod";
import { AncestryProbe } from "./ancestry.ts";
import { cleanupOwned } from "./cleanup.ts";
import { SessionOwnership } from "./ownership.ts";
export class OpenCodeSession implements ProviderSession {
  private ctx: SessionContext;
  private server: OpenCodeServer;
  private client: OpenCodeClient;
  private controller = new AbortController();
  private translator: OpenCodeTranslator;
  private ownership: SessionOwnership;
  private history = new HistoryReader();
  private sequence = 0;
  private promptSequence = 0;
  private started: number;
  private opening = true;
  private closed = false;
  private exitReported = false;
  private recovering = false;
  private openingBuffer: unknown[] = [];
  private openingBytes = 0;
  private moves = new Set<string>();
  private snapshotBytes = 0;
  private snapshots: { channel: string; data: unknown; session: string; started: number }[] = [];
  private latest = new Map<string, number>();
  private pending = new Map<
    string,
    { session: string; data: Record<string, unknown>; type: string }
  >();
  private waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private unsubscribe: () => void = () => {};
  private abortListener: () => void;
  private sending = false;
  private admissionRejected = false;
  private executionObserved = new Set<string>();
  private recoveryRead: Promise<void> | undefined;
  private ancestry: AncestryProbe;
  private recoveryStarted = 0;
  get nativeSessionId(): string {
    return this.ownership.root;
  }
  private constructor(ctx: SessionContext, server: OpenCodeServer) {
    this.ctx = ctx;
    this.server = server;
    this.started = server.runtime.monotonic();
    this.translator = new OpenCodeTranslator({
      threadId: ctx.threadId,
      rootKey: ctx.rootKey ?? "root",
    });
    this.ownership = new SessionOwnership(ctx.cwd, ctx.resume?.nativeSessionId ?? "");
    this.client = server.scoped(ctx.cwd, this.emit, this.controller.signal);
    this.ancestry = new AncestryProbe({
      client: this.client,
      ownership: this.ownership,
      directory: () => this.ownership.sessions.get(this.ownership.root)?.directory ?? this.ctx.cwd,
      info: (info) => this.emit("recv", "snapshot.info", { info }),
      receive: (data) => this.receive(data),
    });
    this.abortListener = () => {
      void this.close("shutdown");
    };
  }
  static async open(ctx: SessionContext, server: OpenCodeServer): Promise<OpenCodeSession> {
    ctx.signal.throwIfAborted();
    await server.ready(ctx.signal);
    if (ctx.signal.aborted) {
      await server.release();
      ctx.signal.throwIfAborted();
    }
    const s = new OpenCodeSession(ctx, server);
    s.unsubscribe = server.subscribe({
      accepts: (data, watermark) => {
        if (!s.owns(data)) return false;
        const id = eventSession(data);
        if (id) s.latest.set(id, watermark);
        return true;
      },
      receive: (data) => s.receive(data),
      frame: s.emit,
      disconnected: (started) => {
        s.recovering = true;
        s.recoveryStarted = started;
        s.emit("note", "lifecycle", { type: "disconnected" });
      },
      reconcile: (data) => {
        const type = string(object(data).type);
        if (!type.endsWith(".delta")) s.receive(data);
      },
      resync: () => s.resync(),
      finalizeSnapshots: () => s.finalizeSnapshots(),
      recovered: () => {
        s.recovering = false;
        s.emit("note", "lifecycle", { type: "resynced" });
        for (const w of s.waiters) w.resolve();
        s.waiters.clear();
      },
      exited: (deliberate, message) => {
        s.reportExit(deliberate, message);
        void s.close("shutdown");
      },
    });
    ctx.signal.addEventListener("abort", s.abortListener, { once: true });
    try {
      s.emit("note", "lifecycle", { type: "started" });
      const info = SessionInfo.parse(
        ctx.resume
          ? await s.client.session.get({ sessionID: ctx.resume.nativeSessionId })
          : await s.client.session.create({
              title: "ace",
              location: { directory: ctx.cwd },
              model: selectedModel(ctx.model),
              permissions: [],
            }),
      );
      s.ownership.establish(info);
      s.emit("recv", "snapshot.info", { info, root: true });
      s.opening = false;
      for (const event of s.openingBuffer.splice(0)) s.receive(event);
      if (ctx.resume) {
        s.recovering = true;
        await s.resync();
        s.finalizeSnapshots();
        s.recovering = false;
      }
      ctx.signal.throwIfAborted();
      return s;
    } catch (error) {
      await s.close("shutdown");
      throw error;
    }
  }
  private emit = (dir: Frame["dir"], channel: string, data: unknown): void => {
    const t = Math.round(this.server.runtime.monotonic() - this.started);
    const payload = new ProviderPayload(JSON.stringify(data));
    const frame: Frame = { seq: this.sequence++, t, dir, channel, data: payload.data, payload };
    if (
      dir === "recv" &&
      channel === "http" &&
      String(object(data).path).endsWith("/prompt") &&
      typeof object(data).status === "number" &&
      Number(object(data).status) >= 400
    )
      this.admissionRejected = true;
    this.translator.translate(frame, t);
    this.ctx.onFrame(frame);
  };
  private owns(data: unknown): boolean {
    if (this.closed) return false;
    if (this.opening) {
      const directory = string(object(object(data).location).directory);
      return directory === this.ctx.cwd;
    }
    const accepted = this.ownership.accept(data);
    if (!accepted) this.ancestry.prove(data);
    if (accepted && object(data).type === "session.moved") {
      const id = eventSession(data);
      // Refetch a known ID before changing its stored location or accepting new-project frames.
      if (this.moves.has(id)) return accepted;
      this.moves.add(id);
      void this.client.session
        .get({ sessionID: id })
        .then((value) => {
          const info = SessionInfo.parse(value);
          this.ownership.verify(info);
          this.emit("recv", "snapshot.info", { info });
        })
        .catch(() => {
          void this.server.reconcileNow();
        })
        .finally(() => this.moves.delete(id));
    }
    return accepted;
  }
  private receive(data: unknown): void {
    if (this.opening) {
      this.openingBytes += Buffer.byteLength(JSON.stringify(data));
      if (this.openingBuffer.length >= 128 || this.openingBytes > 8 * 1024 * 1024)
        throw new Error("OpenCode startup event limit");
      this.openingBuffer.push(data);
      return;
    }
    if (!this.owns(data)) return;
    const e = NativeEvent.parse(data),
      p = e.data;
    if (!e.id.startsWith("snapshot:")) this.latest.set(eventSession(e), this.server.eventWatermark);
    if (e.type === "permission.asked" || e.type === "form.created") {
      const value = e.type === "form.created" ? object(p.form) : p,
        session = string(value.sessionID);
      const key = `${e.type === "permission.asked" ? "permission" : "form"}:${session}:${string(value.id)}`;
      if (this.pending.size >= 1024 && !this.pending.has(key))
        throw new Error("OpenCode interaction limit");
      this.pending.set(key, { session, data: value, type: e.type });
    } else if (
      e.type === "permission.replied" ||
      e.type === "form.replied" ||
      e.type === "form.cancelled"
    ) {
      this.pending.delete(
        `${e.type === "permission.replied" ? "permission" : "form"}:${string(p.sessionID)}:${string(p.requestID, string(p.id))}`,
      );
    }
    if (e.type.startsWith("session.execution.") || e.type.startsWith("session.step."))
      this.executionObserved.add(eventSession(e));
    this.emit("recv", "sse", e);
    if (e.type === "shell.exited" || e.type === "shell.deleted")
      this.ownership.shells.delete(string(p.id));
    if (e.type === "shell.created" && object(p.info).status !== "running")
      this.ownership.shells.delete(string(object(p.info).id));
  }
  private async barrier(): Promise<void> {
    if (this.closed) throw new Error("OpenCode session is closed");
    if (!this.recovering) return;
    if (this.waiters.size >= 64) throw new Error("OpenCode recovery send limit");
    await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
    this.controller.signal.throwIfAborted();
  }
  async send(input: ContentPart[], delivery: "steer" | "queue"): Promise<void> {
    await this.barrier();
    if (this.sending) throw new Error("OpenCode input admission already in progress");
    this.sending = true;
    this.admissionRejected = false;
    const id = messageId(
      this.server.runtime.wallTime(),
      ++this.promptSequence,
      this.server.runtime.entropy(16),
    );
    try {
      // Engine owns waiting-to-send. Native inbox owns an input exactly once after admission.
      const reply = z
        .object({ id: z.literal(id), sessionID: z.literal(this.nativeSessionId) })
        .passthrough()
        .parse(
          await this.client.session.prompt({
            sessionID: this.nativeSessionId,
            ...promptBody(
              input,
              this.ownership.sessions.get(this.nativeSessionId)?.directory ?? this.ctx.cwd,
              id,
            ),
            delivery,
          }),
        );
      this.emit("note", "input.accepted", reply);
    } catch {
      if (this.admissionRejected) {
        this.emit("note", "input.rejected", { id });
        throw new Error("OpenCode rejected input admission");
      }
      // The server may have committed admission before the socket failed. Never retry.
      this.recovering = true;
      this.emit("note", "lifecycle", { type: "disconnected" });
      void this.server.reconcileNow();
      throw new Error(
        "OpenCode input acknowledgement uncertain; reconcile inbox before sending again",
      );
    } finally {
      this.sending = false;
    }
  }
  async interrupt(target: { agent?: Key; cascade: boolean }): Promise<void> {
    await this.barrier();
    const root =
      !target.agent || target.agent === this.ctx.rootKey || target.agent === "root"
        ? this.nativeSessionId
        : target.agent;
    if (!this.ownership.sessions.has(root)) throw new Error("Unknown OpenCode agent");
    const ids = target.cascade ? this.ownership.descendants(root).concat(root) : [root];
    for (const sessionID of ids) {
      const result = z
        .object({ interrupted: z.boolean() })
        .parse(await this.client.session.interrupt({ sessionID }));
      if (!result.interrupted) throw new Error("OpenCode interrupt was not accepted");
    }
    if (target.cascade)
      for (const [id, owner] of this.ownership.shells)
        if (ids.includes(owner)) await this.removeShell(id);
  }
  async resolve(key: Key, choice: InteractionResolution): Promise<void> {
    await this.barrier();
    const pending = this.pending.get(key);
    if (!pending) throw new Error("OpenCode interaction is no longer pending");
    const command = nativeResolution(choice, pending);
    if (command.kind === "permission") await this.client.permission.reply(command);
    else if (command.cancel)
      await this.client.session.form.cancel({
        sessionID: command.sessionID,
        formID: command.formID,
        ...(command.message === undefined ? {} : { message: command.message }),
      });
    else
      await this.client.session.form.reply({
        sessionID: command.sessionID,
        formID: command.formID,
        answer: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .parse(command.answer),
      });
  }
  private async removeShell(id: string): Promise<void> {
    const owner = this.ownership.shells.get(id);
    if (!owner) throw new Error("Unknown OpenCode shell");
    const location = { directory: this.ownership.sessions.get(owner)?.directory ?? this.ctx.cwd };
    await this.client.shell.remove({ id, location });
  }
  async stopTask(task: Key): Promise<void> {
    await this.barrier();
    if (task.startsWith("shell:")) return this.removeShell(task.slice(6));
    const owner = task.startsWith("child:") ? task.slice(6) : this.translator.taskOwner(task);
    if (!owner || !this.ownership.sessions.has(owner)) throw new Error("Unknown OpenCode task");
    await this.interrupt({ agent: owner, cascade: true });
  }
  async resync(): Promise<void> {
    this.recoveryRead ??= this.readSnapshots().finally(() => {
      this.recoveryRead = undefined;
    });
    await this.recoveryRead;
  }
  private async readSnapshots(): Promise<void> {
    if (this.closed || this.opening) return;
    this.snapshots = [];
    this.snapshotBytes = 0;
    await recoverSessions({
      client: this.client,
      ownership: this.ownership,
      history: this.history,
      watermark: () => this.server.eventWatermark,
      frame: this.emit,
      receive: (event) => this.receive(event),
      stage: (channel, data, session, started) => {
        this.snapshotBytes += Buffer.byteLength(JSON.stringify(data));
        if (this.snapshotBytes > 8 * 1024 * 1024 || this.snapshots.length >= 4096)
          throw new Error("OpenCode snapshot budget exceeded");
        this.snapshots.push({
          channel,
          data,
          session,
          started: Math.min(started, this.recoveryStarted),
        });
      },
      liveMessages: (id) => this.translator.liveMessages(id),
      executionObserved: this.executionObserved,
      shell: async (id, directory) => {
        let status = 0;
        const client = this.server.scoped(
          directory,
          (dir, channel, data) => {
            if (dir === "recv" && channel === "http") status = Number(object(data).status);
            this.emit(dir, channel, data);
          },
          this.controller.signal,
        );
        try {
          return await client.shell.get({ id, location: { directory } });
        } catch {
          if (status === 404) return undefined;
          throw new Error("OpenCode shell recovery incomplete");
        }
      },
    });
  }

  private finalizeSnapshots(): void {
    for (const snap of this.snapshots.splice(0)) {
      if ((this.latest.get(snap.session) ?? 0) > snap.started) continue;
      this.emit("recv", snap.channel, snap.data);
      if (snap.channel === "snapshot.interactions") {
        const keys = new Set(z.array(z.string()).parse(object(snap.data).keys));
        for (const [key, pending] of this.pending)
          if (pending.session === snap.session && !keys.has(key)) this.pending.delete(key);
      }
    }
  }
  private reportExit(deliberate: boolean, message?: string): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.emit("note", "lifecycle", { type: "exited", deliberate, message });
    this.ctx.onExit({ deliberate, ...(message ? { message } : {}) });
  }
  async close(reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (this.closed) return;
    if (reason === "idle" && !this.translator.isSettled())
      throw new Error("Cannot idle-close unsettled OpenCode session");
    this.closed = true;
    this.controller.abort();
    this.unsubscribe();
    this.ctx.signal.removeEventListener("abort", this.abortListener);
    for (const waiter of this.waiters) waiter.reject(new Error("OpenCode session closed"));
    this.waiters.clear();
    if (reason !== "idle") await cleanupOwned(this.server, this.ownership);
    this.reportExit(true);
    await this.server.release();
  }
}
