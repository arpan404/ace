import { waitForAceTools } from "./mcp-ready.ts";
import { createExtensionCatalog } from "./extension-catalog.ts";
import { openCodeMcpControls } from "./mcp-controls.ts";
import { developerInstructions } from "@ace/mcp-server";
import { registerAceMcp } from "./mcp-registration.ts";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import { opencodePermissionAgent } from "./permission-policy.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Key } from "@ace/core";
import type { ContentPart, InteractionResolution, ExecutionSelection } from "@ace/protocol";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import type { OpenCodeClient } from "@opencode/client";
import { NativeEvent, SessionInfo, eventSession } from "./boundaries.ts";
import { object, string } from "./data.ts";
import { recoverSessions } from "./recovery.ts";
import { HistoryReader } from "./history.ts";
import { OpenCodeTranslator } from "./translator.ts";
import { request, resolveNativeInteraction } from "./commands.ts";
import { selectedModel } from "./input.ts";
import { OpenCodeServer } from "./server.ts";
import { z } from "zod";
import { SessionPrompts } from "./prompts.ts";
import { AncestryProbe } from "./ancestry.ts";
import { cleanupOwned } from "./cleanup.ts";
import { SessionOwnership } from "./ownership.ts";
import { RecoveryEvidence } from "./recovery-evidence.ts";
export class OpenCodeSession implements ProviderSession {
  private mcpDirectories = new Set<string>();
  private ctx: SessionContext;
  private server: OpenCodeServer;
  private client: OpenCodeClient;
  private catalog: ReturnType<typeof createExtensionCatalog>;
  private controller = new AbortController();
  private translator: OpenCodeTranslator;
  private ownership: SessionOwnership;
  private history = new HistoryReader();
  private sequence = 0;
  private started: number;
  private opening = true;
  private closed = false;
  private exitReported = false;
  private recovering = false;
  private openingBuffer: unknown[] = [];
  private openingBytes = 0;
  private moves = new Set<string>();
  private evidence = new RecoveryEvidence();
  private lostLocations = new Set<string>();
  private pending = new Map<
    string,
    { session: string; data: Record<string, unknown>; type: string }
  >();
  private waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private unsubscribe: () => void = () => {};
  private abortListener: () => void;
  private prompts: SessionPrompts;
  private executionObserved = new Set<string>();
  private recoveryRead: Promise<void> | undefined;
  private ancestry: AncestryProbe;
  private recoveryStarted = 0;
  get mcp() {
    return openCodeMcpControls(
      this.client,
      () => this.ownership.sessions.get(this.nativeSessionId)?.directory ?? this.ctx.cwd,
    );
  }
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
    this.catalog = createExtensionCatalog(this.client, ctx.cwd, this.emit, () => this.closed);
    this.prompts = new SessionPrompts({
      client: this.client,
      runtime: server.runtime,
      signal: this.controller.signal,
      session: () => this.nativeSessionId,
      directory: () => this.ownership.sessions.get(this.nativeSessionId)?.directory ?? ctx.cwd,
      frame: this.emit,
      correlate: ctx.onInputMessage,
      barrier: () => this.barrier(),
      uncertain: () => {
        if (this.closed) return;
        this.recovering = true;
        this.emit("note", "lifecycle", { type: "disconnected" });
        void this.server.reconcileNow();
      },
    });
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
      ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
      accepts: (data) => s.owns(data),
      receive: (data) => s.receive(data),
      buffered: (data, watermark) => s.evidence.observe(data, watermark),
      frame: s.emit,
      disconnected: (started) => {
        s.recovering = true;
        s.evidence.reset();
        s.recoveryStarted = started;
        s.emit("note", "lifecycle", { type: "disconnected" });
      },
      reconcile: (data, watermark) => {
        if (!s.evidence.covered(data, watermark)) s.receive(data);
      },
      prepareReplay: () => {
        for (const snap of s.evidence.positive()) s.emit("recv", snap.channel, snap.data);
      },
      close: () => s.close("shutdown"),
      resync: () => s.resync(),
      finalizeSnapshots: () => s.finalizeSnapshots(),
      recovered: () => {
        s.recovering = false;
        s.evidence.reset();
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
              model: selectedModel(ctx.model, ctx.options),
              ...(ctx.permissionMode ? { agent: opencodePermissionAgent(ctx.permissionMode) } : {}),
            }),
      );
      if (ctx.resume) {
        if (ctx.permissionMode)
          await s.client.session.switchAgent({
            sessionID: info.id,
            agent: opencodePermissionAgent(ctx.permissionMode),
          });
        const model = selectedModel(ctx.model, ctx.options);
        const previous = z
          .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
          .safeParse(info.model);
        if (
          model &&
          (!previous.success ||
            previous.data.providerID !== model.providerID ||
            previous.data.id !== model.id ||
            previous.data.variant !== model.variant)
        ) {
          await s.client.session.switchModel({ sessionID: info.id, model });
          info.model = model;
        }
      }
      if (ctx.aceMcp)
        await s.client.session.instructions.entry.put({
          sessionID: info.id,
          key: "ace.tool-guidance",
          value: developerInstructions("opencode"),
        });
      s.ownership.establish(info);
      await s.ensureMcp(info.location.directory);
      s.emit("recv", "snapshot.info", { info, root: true });
      s.opening = false;
      for (const event of s.openingBuffer.splice(0)) s.receive(event);
      if (ctx.resume) {
        s.recovering = true;
        s.emit("note", "lifecycle", { type: "disconnected" });
        await s.resync();
        s.finalizeSnapshots();
        s.recovering = false;
        s.emit("note", "lifecycle", { type: "resynced" });
      }
      await s.catalog.start();
      ctx.signal.throwIfAborted();
      return s;
    } catch (error) {
      // Capture before closing the last lease clears the server's redaction secrets.
      const failure = new SessionOpenError(
        "OpenCode session opening failed",
        error,
        { env: ctx.env, workspace: ctx.cwd },
        (value) => server.redact(value),
      );
      // Cleanup failure must not replace the cause that prevented opening.
      await s.close("shutdown").catch(() => {});
      throw failure;
    }
  }
  private emit = (dir: Frame["dir"], channel: string, data: unknown): void => {
    if (this.closed && !(channel === "lifecycle" && object(data).type === "exited")) return;
    const t = Math.round(this.server.runtime.monotonic() - this.started);
    const encoded = JSON.stringify(this.server.redact(data));
    const bearer = this.ctx.aceMcp?.bearer;
    const payload = new ProviderPayload(
      bearer && encoded.includes(bearer) ? encoded.replaceAll(bearer, "[REDACTED]") : encoded,
    );
    const frame: Frame = { seq: this.sequence++, t, dir, channel, data: payload.data, payload };
    this.prompts.observe(dir, channel, data);
    if (
      channel.startsWith("snapshot.") &&
      channel !== "snapshot.info" &&
      this.lostLocations.has(
        this.ownership.sessions.get(string(object(data).sessionID))?.directory ?? "",
      )
    )
      return;
    if (channel === "snapshot.message" && this.recovering) this.evidence.message(payload.data);
    this.translator.translate(frame, t);
    this.ctx.onFrame(frame);
  };
  private owns(data: unknown): boolean {
    if (this.closed) return false;
    if (this.opening) {
      const directory = string(object(object(data).location).directory);
      return directory === this.ctx.cwd;
    }
    const envelope = object(data),
      ownerID =
        eventSession(data) || this.ownership.shells.get(string(object(envelope.data).id)) || "";
    const directory = string(
      object(envelope.location).directory,
      this.ownership.sessions.get(ownerID)?.directory ?? "",
    );
    if (
      envelope.type !== "session.moved" &&
      envelope.type !== "location.shutdown" &&
      this.lostLocations.has(directory)
    )
      return false;
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
          for (const lostDirectory of this.lostLocations)
            if (!this.ownership.atLocation(lostDirectory).size)
              this.lostLocations.delete(lostDirectory);
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
    this.catalog.changed(e.type);
    if (e.type === "location.shutdown" && e.location) {
      this.lostLocations.add(e.location.directory);
      const owners = this.ownership.atLocation(e.location.directory);
      for (const [key, pending] of this.pending)
        if (owners.has(pending.session)) this.pending.delete(key);
    }
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
  private requireLocation(id: string): void {
    if (this.lostLocations.has(this.ownership.sessions.get(id)?.directory ?? ""))
      throw new Error("OpenCode location is unavailable");
  }
  private async barrier(): Promise<void> {
    if (this.closed) throw new Error("OpenCode session is closed");
    this.requireLocation(this.nativeSessionId);
    if (this.recovering) {
      if (this.waiters.size >= 64) throw new Error("OpenCode recovery send limit");
      await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
    }
    this.controller.signal.throwIfAborted();
    this.requireLocation(this.nativeSessionId);
    await this.ensureMcp(
      this.ownership.sessions.get(this.nativeSessionId)?.directory ?? this.ctx.cwd,
    );
  }
  async configure(selection: ExecutionSelection): Promise<void> {
    if (selection.provider !== "opencode" || !selection.model)
      throw new Error("Invalid OpenCode selection");
    await this.barrier();
    const model = selectedModel(selection.model, selection.options);
    if (!model) throw new Error("Missing OpenCode model");
    await this.client.session.switchModel({ sessionID: this.nativeSessionId, model });
    this.ctx = { ...this.ctx, model: selection.model, options: selection.options };
  }
  send(input: ContentPart[], delivery: "steer" | "queue", commandId?: string): Promise<void> {
    return this.prompts.send(input, delivery, commandId);
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
      this.requireLocation(sessionID);
      const result = z
        .object({ interrupted: z.boolean() })
        .parse(
          await request("interrupt request", () => this.client.session.interrupt({ sessionID })),
        );
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
    this.requireLocation(pending.session);
    this.emit("note", "interaction.resolving", { key, resolution: choice });
    try {
      await resolveNativeInteraction(this.client, pending, choice);
    } catch {
      this.emit("note", "interaction.rejected", { key });
      throw new Error("OpenCode interaction response rejected or uncertain");
    }
  }
  private async removeShell(id: string): Promise<void> {
    const owner = this.ownership.shells.get(id);
    if (!owner) throw new Error("Unknown OpenCode shell");
    this.requireLocation(owner);
    const location = { directory: this.ownership.sessions.get(owner)?.directory ?? this.ctx.cwd };
    await request("shell removal", () => this.client.shell.remove({ id, location }));
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
  private async ensureMcp(directory: string): Promise<void> {
    if (!this.ctx.aceMcp || this.mcpDirectories.has(directory)) return;
    if (this.mcpDirectories.size >= 128) throw new Error("OpenCode MCP location limit exceeded");
    await registerAceMcp(this.client, directory, this.ctx.aceMcp);
    await waitForAceTools(this.client, directory, this.server.runtime);
    this.mcpDirectories.add(directory);
  }
  private async readSnapshots(): Promise<void> {
    if (this.closed || this.opening) return;
    this.evidence.pass();
    await recoverSessions({
      client: this.client,
      ownership: this.ownership,
      history: this.history,
      watermark: () => this.server.eventWatermark,
      frame: this.emit,
      receive: (event) => this.receive(event),
      stage: (channel, data, session, started) =>
        this.evidence.stage(channel, data, session, Math.min(started, this.recoveryStarted)),
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
    for (const snap of [...this.evidence.positive(), ...this.evidence.finish()]) {
      this.emit("recv", snap.channel, snap.data);
      if (snap.channel === "snapshot.interactions") {
        const keys = this.evidence.interactionKeys(snap.data);
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
    this.ctx.aceMcp?.end?.();
    for (const waiter of this.waiters) waiter.reject(new Error("OpenCode session closed"));
    this.waiters.clear();
    if (reason !== "idle") await cleanupOwned(this.server, this.ownership);
    this.reportExit(true);
    await this.server.release();
  }
}
