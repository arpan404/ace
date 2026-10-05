import { NavigationPolicies } from "./policy-waits.ts";
import { BrowserActionError } from "./action-error.ts";
import { BrowserOriginError } from "./policy.ts";
import { z } from "zod";
import { join } from "node:path";
import type { BrowserBackendSession } from "./backend.ts";
import type { BrowserOriginBlock, BrowserControllerLease } from "@ace/protocol";
import {
  BrowserCommand,
  BrowserInput,
  type BrowserArtifact,
  type BrowserState,
} from "@ace/protocol";
import { LiveCapture } from "./live.ts";
import { SessionLogs } from "./logs.ts";
import { SnapshotRefs } from "./refs.ts";
import { Recording } from "./recording.ts";
import { keyEvent } from "./keyboard.ts";
import type { NavigationTask } from "./navigation.ts";
import { executeBrowserCommand } from "./session-commands.ts";

import type { Actor, SessionOptions } from "./session-options.ts";
export type { Actor, SessionOptions } from "./session-options.ts";
const ScreenshotBytes = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= 8 * 1024 * 1024, "Browser screenshot exceeds image limit");

const inputActions = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "emulate",
  "tabs",
  "upload",
  "dialog",
  "hover",
  "drag",
  "select",
  "check",
  "uncheck",
  "focus",
  "record_start",
  "record_stop",
]);

export class BrowserSession {
  readonly live: LiveCapture;
  private refs: SnapshotRefs;
  private logs: SessionLogs;
  private options: SessionOptions;
  private controller: BrowserState["controller"] = "agent";
  private owner: string | undefined;
  private takeoverMode: "shared" | "private" = "shared";
  private privateEpoch = 0;
  private activeTabId: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private dialogWaiters = new Set<() => void>();
  private dialogWork: Promise<void> | undefined;
  private recording: Recording | undefined;
  private paused = false;
  private blocked: BrowserOriginBlock | undefined;
  private policies = new NavigationPolicies();
  get navigationTask(): NavigationTask | undefined {
    return this.policies.task;
  }
  initiatingHuman(): boolean {
    return this.policies.task?.human ?? this.controller === "human";
  }
  blockedNavigation(blocked: BrowserOriginBlock, navigation?: NavigationTask): void {
    // A cancelled policy may settle after the next queued navigation starts.
    if (navigation && navigation !== this.policies.task) return;
    if (navigation) navigation.blocked = blocked;
    this.blocked = blocked;
    this.emit();
  }
  policyWait(url: string): () => void {
    return this.policies.wait(url);
  }
  private lastUrl: string | undefined;
  private reason: string | undefined;
  private pageStateLost = false;
  private generation = 0;
  private leaseReady: Promise<void> = Promise.resolve();
  private syncLease(): void {
    const lease: BrowserControllerLease = {
      generation: ++this.generation,
      controller: this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
    };
    const backend = this.options.backend;
    this.leaseReady = backend.controller(lease);
    void this.leaseReady.catch((error) => {
      if (lease.generation === this.generation)
        this.suspend(error instanceof Error ? error.message : "Controller lease failed");
    });
  }
  navigation(): void {
    this.blocked = undefined;
    this.refs.invalidate();
    this.emit();
  }
  log(entry: import("./backend.ts").BackendLog): void {
    if (this.takeoverMode === "private") return;
    this.logs.append(entry.kind, { ...entry, at: this.options.now() });
  }
  suspend(reason: string): void {
    if (this.closed || this.paused) return;
    this.lastUrl = this.options.backend.url();
    this.paused = true;
    this.reason = reason.slice(0, 2048);
    this.pageStateLost = true;
    this.generation++;
    this.refs.invalidate();
    this.live.detach();
    this.emit();
  }
  recoveryFailed(reason: string): void {
    this.reason = `Headless recovery failed: ${reason}`.slice(0, 2048);
    this.paused = true;
    this.emit();
  }
  async replace(backend: BrowserBackendSession): Promise<void> {
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    await this.tail;
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    await this.options.backend.close().catch(() => {});
    this.options.backend = backend;
    this.options.backendKind = "headless";
    this.refs.replace(backend.cdp);
    this.leaseReady = Promise.resolve();
    this.syncLease();
    await this.leaseReady;
    await this.live.replace(backend.cdp);
    this.lastUrl = undefined;
    this.paused = false;
    this.reason = "Recovered in headless browser; page state was lost";
    this.emit();
  }
  constructor(options: SessionOptions) {
    this.options = options;
    this.refs = new SnapshotRefs(
      options.backend.cdp,
      options.backend.frames ? () => options.backend.frames?.() ?? Promise.resolve([]) : undefined,
    );
    this.activeTabId = options.backend.tabs?.active();
    this.logs = new SessionLogs(options.dir);
    this.live = new LiveCapture(
      options.backend.cdp,
      options.now,
      (frame) => this.takeoverMode !== "private" && this.recording?.accept(frame),
    );
  }

  get state(): BrowserState {
    return {
      threadId: this.options.threadId,
      controller: this.paused ? "none" : this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
      url: (this.lastUrl ?? this.options.backend.url()).slice(0, 8192),
      backend: this.options.backendKind,
      status: this.paused ? "paused" : "ready",
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.pageStateLost ? { pageStateLost: true } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
      closed: this.closed,
      takeoverMode: this.takeoverMode,
      ...(this.options.backend.tabs
        ? {
            activeTabId: this.options.backend.tabs.active(),
            tabs: this.options.backend.tabs.list(),
            downloads: this.options.backend.tabs.downloads(),
            pending_dialog: this.options.backend.tabs.dialog(),
          }
        : {}),
    };
  }
  private emit(): void {
    this.options.state(this.state);
  }
  restorePrivate(): void {
    this.takeoverMode = "private";
    this.controller = "human";
    this.paused = true;
    this.reason = "Private browser interrupted; explicit handback required";
    this.privateEpoch++;
    this.refs.invalidate();
    this.options.backend.privateMode?.(true);
    this.syncLease();
    this.emit();
  }
  takeover(connectionId: string, mode: "shared" | "private" = "shared"): BrowserState {
    if (this.closed) throw new BrowserActionError("browser_closed");
    if (this.owner && this.owner !== connectionId)
      throw new Error("Browser already controlled by another connection");
    if (this.owner === connectionId && this.takeoverMode === mode) return this.state;
    if (this.takeoverMode === "private" || mode === "private") {
      this.refs.invalidate();
      this.privateEpoch++;
    }
    this.takeoverMode = mode;
    this.options.backend.privateMode?.(mode === "private");
    this.controller = "human";
    this.owner = connectionId;
    if (this.paused && !this.pageStateLost) {
      this.paused = false;
      this.reason = undefined;
    }
    if (!this.paused) this.syncLease();
    this.emit();
    return this.state;
  }
  handback(connectionId: string): BrowserState {
    if (this.owner !== connectionId) throw new Error("Browser controller mismatch");
    this.controller = "agent";
    this.owner = undefined;
    if (this.takeoverMode === "private") {
      this.refs.invalidate();
      this.privateEpoch++;
    }
    this.takeoverMode = "shared";
    this.options.backend.privateMode?.(false);
    if (this.paused && !this.pageStateLost) {
      this.paused = false;
      this.reason = undefined;
    }
    this.options.privateResumed?.();
    if (!this.paused) this.syncLease();
    this.emit();
    return this.state;
  }
  disconnect(connectionId: string): void {
    if (this.owner !== connectionId) return;
    if (this.takeoverMode === "private") {
      this.owner = undefined;
      this.paused = true;
      this.reason = "Private takeover disconnected; explicit handback required";
      this.options.privatePaused?.();
      this.syncLease();
      this.emit();
    } else this.handback(connectionId);
  }
  private check(actor: Actor, signal?: AbortSignal, generation = this.generation): void {
    signal?.throwIfAborted();
    // Report what blocks the action now before reporting that it went stale: a person who
    // still holds control must see "controlled by human", not a generic generation change.
    if (this.closed) throw new BrowserActionError("browser_closed");
    this.readCheck(actor);
    if (this.paused) throw new BrowserActionError("browser_paused");
    if (actor.kind === "agent" && this.controller !== "agent")
      throw new BrowserActionError("human_controlled");
    if (generation !== this.generation)
      throw new BrowserActionError(
        "controller_changed",
        "Browser control changed while the action was queued",
        "Take a fresh snapshot and retry after control is handed back.",
      );
    if (
      actor.kind === "human" &&
      (this.controller !== "human" || this.owner !== actor.connectionId)
    )
      throw new Error("Browser controller mismatch");
  }
  private readCheck(actor: Actor, epoch = this.privateEpoch): void {
    if (actor.kind === "agent" && (this.takeoverMode === "private" || epoch !== this.privateEpoch))
      throw new BrowserActionError("human_private");
  }
  changed(): void {
    if (this.options.backend.tabs?.dialog()) for (const notify of this.dialogWaiters) notify();
    if (this.closed) return;
    this.emit();
    if (this.options.backend.tabs?.active() !== this.activeTabId && !this.paused)
      void this.enqueue(() => this.syncTab()).catch((error) => {
        if (!this.closed)
          this.suspend(error instanceof Error ? error.message : "Tab capture failed");
      });
  }
  private async syncTab(): Promise<void> {
    const tabId = this.options.backend.tabs?.active();
    if (tabId === this.activeTabId) return;
    this.activeTabId = tabId;
    this.refs.replace(this.options.backend.cdp);
    await this.live.replace(this.options.backend.cdp);
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserActionError("browser_closed"));
    if (this.pending >= 32) return Promise.reject(new BrowserActionError("queue_full"));
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  execute(raw: unknown, actor: Actor = { kind: "agent" }, signal?: AbortSignal): Promise<unknown> {
    const command = BrowserCommand.parse(raw);
    const submittedGeneration = this.generation;
    const privateEpoch = this.privateEpoch;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      this.readCheck(actor, privateEpoch);
      if (this.closed) throw new BrowserActionError("browser_closed");
      if (
        inputActions.has(command.action) &&
        !(command.action === "tabs" && command.operation === "list")
      ) {
        this.check(actor, signal, submittedGeneration);
      }
      if (this.paused) throw new BrowserActionError("browser_paused");
      const generation = this.generation;
      if (
        inputActions.has(command.action) &&
        !(command.action === "tabs" && command.operation === "list")
      ) {
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
      }
      if (command.tabId && command.action !== "tabs") {
        this.check(actor, signal, submittedGeneration);
        await this.options.backend.tabs?.switch(command.tabId);
      }
      if (command.action !== "dialog") {
        const pending_dialog = this.options.backend.tabs?.dialog();
        if (pending_dialog)
          return command.action === "tabs" && command.operation === "list"
            ? {
                activeTabId: this.options.backend.tabs?.active(),
                tabs: this.options.backend.tabs?.list(),
              }
            : { pending_dialog };
        await this.dialogWork;
        this.readCheck(actor, privateEpoch);
        if (
          inputActions.has(command.action) &&
          !(command.action === "tabs" && command.operation === "list")
        )
          this.check(actor, signal, submittedGeneration);
      }
      await this.syncTab();
      this.readCheck(actor, privateEpoch);
      let result: unknown;
      try {
        result =
          command.action === "dialog"
            ? await this.run(command, actor, signal, submittedGeneration)
            : await this.runUntilDialog(() =>
                this.run(command, actor, signal, submittedGeneration),
              );
      } catch (error) {
        if (error instanceof BrowserOriginError) this.blockedNavigation(error.blocked);
        throw error;
      }
      this.readCheck(actor, privateEpoch);
      if (this.paused || (generation !== this.generation && this.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return result;
    });
  }
  /** Dialogs pause renderer replies; return their state so the next tool can answer. */
  private async runUntilDialog(run: () => Promise<unknown>): Promise<unknown> {
    let notify: (() => void) | undefined;
    const dialog = new Promise<unknown>((resolve) => {
      notify = () => {
        const pending_dialog = this.options.backend.tabs?.dialog();
        if (pending_dialog) resolve({ pending_dialog });
      };
      this.dialogWaiters.add(notify);
    });
    const work = run();
    const settled = work.then(
      () => {},
      () => {},
    );
    this.dialogWork = settled;
    void settled.then(() => {
      if (this.dialogWork === settled) this.dialogWork = undefined;
    });
    notify?.();
    try {
      return await Promise.race([work, dialog]);
    } finally {
      if (notify) this.dialogWaiters.delete(notify);
    }
  }
  screenshot(signal?: AbortSignal, tabId?: string): Promise<Uint8Array> {
    const submittedGeneration = this.generation;
    const privateEpoch = this.privateEpoch;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      this.readCheck({ kind: "agent" }, privateEpoch);
      if (this.closed) throw new BrowserActionError("browser_closed");
      if (this.paused) throw new BrowserActionError("browser_paused");
      if (tabId) {
        this.check({ kind: "agent" }, signal, submittedGeneration);
        await this.options.backend.tabs?.switch(tabId);
      }
      await this.syncTab();
      const generation = this.generation;
      const bytes = await this.options.backend.screenshot("jpeg");
      signal?.throwIfAborted();
      this.readCheck({ kind: "agent" }, privateEpoch);
      if (this.paused || (generation !== this.generation && this.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return ScreenshotBytes.parse(bytes);
    });
  }
  private refDispatch(
    ref: string,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ) {
    const document = this.refs.guard(ref);
    const prepare = () => this.check(actor, signal, generation);
    return {
      prepare,
      send: () => {
        prepare();
        document();
      },
    };
  }
  closeBy(actor: Actor, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.readCheck(actor);
    if (actor.kind === "agent" && (this.controller === "human" || this.owner !== undefined))
      throw new BrowserActionError(
        "human_controlled",
        "Browser controlled by human",
        "Wait for handback before closing.",
      );
    if (actor.kind === "human" && this.owner !== undefined && this.owner !== actor.connectionId)
      throw new Error("Browser controller mismatch");
    return this.close();
  }
  private run(
    command: BrowserCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<unknown> {
    const epoch = this.privateEpoch;
    return executeBrowserCommand(command, actor, signal, generation, {
      options: this.options,
      refs: this.refs,
      logs: this.logs,
      policies: this.policies,
      state: () => this.state,
      read: () => this.readCheck(actor, epoch),
      blocked: () => this.blocked,
      clearBlocked: () => {
        this.blocked = undefined;
      },
      check: (...args) => this.check(...args),
      refDispatch: (...args) => this.refDispatch(...args),
      syncTab: () => this.syncTab(),
      emit: () => this.emit(),
      run: (...args) => this.run(...args),
      beginRecording: (check) => this.beginRecording(check),
      finishRecording: () => this.finishRecording(),
    });
  }
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const generation = this.generation;
    return this.enqueue(async () => {
      this.check({ kind: "human", connectionId }, undefined, generation);
      await this.leaseReady;
      this.check({ kind: "human", connectionId }, undefined, generation);
      const cdp = this.options.backend.cdp;
      switch (input.kind) {
        case "mouse":
          await cdp.send("Input.dispatchMouseEvent", {
            type: input.event,
            x: input.x,
            y: input.y,
            button: input.button,
            clickCount: input.clickCount,
          });
          break;
        case "scroll":
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          });
          break;
        case "key":
          if (input.event === "char")
            await cdp.send("Input.insertText", { text: input.text ?? input.key });
          else await cdp.send("Input.dispatchKeyEvent", keyEvent(input));
          break;
        case "touch":
          await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
          await cdp.send("Input.dispatchTouchEvent", {
            type: input.event,
            touchPoints: input.points,
          });
          break;
      }
    });
  }
  startRecording(): Promise<void> {
    const epoch = this.privateEpoch;
    return this.enqueue(() => this.beginRecording(() => this.readCheck({ kind: "agent" }, epoch)));
  }
  private async beginRecording(
    check: () => void = () => this.readCheck({ kind: "agent" }),
  ): Promise<void> {
    check();
    if (this.paused) throw new Error("Browser backend paused");
    if (this.recording) throw new Error("Recording already started");
    const recording = await Recording.start(
      join(this.options.dir, this.options.id()),
      this.options.ffmpeg,
      undefined,
      this.options.spawn,
    );
    try {
      check();
      const data = await this.options.backend.screenshot("jpeg");
      check();
      const viewport = this.options.backend.viewport();
      recording.accept({
        sequence: 0,
        timestamp: this.options.now(),
        data: data.toString("base64"),
        ...viewport,
      });
      this.recording = recording;
    } catch (error) {
      await recording.stop().catch(() => {});
      throw error;
    }
  }
  stopRecording(): Promise<BrowserArtifact> {
    return this.enqueue(() => this.finishRecording());
  }
  private async finishRecording(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new Error("No browser recording");
    this.recording = undefined;
    const artifact = await recording.stop();
    await this.options.artifact(artifact);
    return artifact;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lastUrl = this.options.backend.url();
      this.closed = true;
      this.options.cancelPolicy();
      this.options.privateResumed?.();
      this.controller = "none";
      this.owner = undefined;
      this.emit();
      // Detach capture synchronously, but do not wait for a CDP stop reply
      // before closing the transport that can abort that pending request.
      try {
        const stopped = this.live.close();
        try {
          await this.options.backend.close();
        } finally {
          await stopped;
          await this.tail;
        }
      } finally {
        try {
          try {
            if (this.recording) await this.finishRecording();
          } finally {
            await this.logs.close();
          }
        } finally {
          await this.options.cleanup();
        }
      }
    })();
    return this.closing;
  }
}
