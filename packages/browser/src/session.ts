import { NavigationPolicies } from "./policy-waits.ts";
import { BrowserActionError } from "./action-error.ts";
import { BrowserOriginError } from "./policy.ts";
import { agentScreenshot } from "./session-images.ts";
import type { BrowserBackendSession } from "./backend.ts";
import type { BrowserOriginBlock } from "@ace/protocol";
import {
  BrowserCommand,
  BrowserInput,
  type BrowserArtifact,
  type BrowserState,
} from "@ace/protocol";
import { LiveCapture } from "./live.ts";
import { SessionLogs } from "./logs.ts";
import { SnapshotRefs } from "./refs.ts";
import { browserState } from "./session-state.ts";
import { closeSession } from "./session-close.ts";
import { SessionOwnership } from "./session-ownership.ts";
import { SessionQueue, mutatesBrowser } from "./session-queue.ts";
import { SessionRecording } from "./session-recording.ts";
import { sendHumanInput } from "./session-input.ts";
import type { NavigationTask } from "./navigation.ts";
import { executeBrowserCommand } from "./session-commands.ts";

import type { Actor, SessionOptions } from "./session-options.ts";
export type { Actor, SessionOptions } from "./session-options.ts";
export class BrowserSession {
  readonly live: LiveCapture;
  private refs: SnapshotRefs;
  private logs: SessionLogs;
  private options: SessionOptions;
  private ownership = new SessionOwnership();
  private activeTabId: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private queue: SessionQueue;
  private recordings: SessionRecording;
  private paused = false;
  private blocked: BrowserOriginBlock | undefined;
  private policies = new NavigationPolicies();
  get navigationTask(): NavigationTask | undefined {
    return this.policies.task;
  }
  initiatingHuman(): boolean {
    return this.policies.task?.human ?? this.ownership.controller === "human";
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
  private leaseReady: Promise<void> = Promise.resolve();
  private syncLease(): void {
    const lease = this.ownership.lease();
    const backend = this.options.backend;
    this.leaseReady = backend.controller(lease);
    void this.leaseReady.catch((error) => {
      if (lease.generation === this.ownership.generation)
        this.suspend(error instanceof Error ? error.message : "Controller lease failed");
    });
  }
  navigation(): void {
    this.blocked = undefined;
    this.refs.invalidate();
    this.emit();
  }
  log(entry: import("./backend.ts").BackendLog): void {
    if (this.ownership.mode === "private") return;
    this.logs.append(entry.kind, { ...entry, at: this.options.now() });
  }
  suspend(reason: string): void {
    if (this.closed || this.paused) return;
    this.lastUrl = this.options.backend.url();
    this.paused = true;
    this.reason = reason.slice(0, 2048);
    this.pageStateLost = true;
    this.ownership.generation++;
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
    await this.queue.settled();
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
    this.queue = new SessionQueue(() => options.backend.tabs?.dialog());
    this.refs = new SnapshotRefs(
      options.backend.cdp,
      options.backend.frames ? () => options.backend.frames?.() ?? Promise.resolve([]) : undefined,
    );
    this.activeTabId = options.backend.tabs?.active();
    this.logs = new SessionLogs(options.dir);
    this.recordings = new SessionRecording(options, () => this.paused);
    this.live = new LiveCapture(
      options.backend.cdp,
      options.now,
      (frame, epoch) =>
        this.ownership.mode !== "private" &&
        epoch === this.ownership.epoch &&
        this.recordings.accept(frame),
      () => ({ epoch: this.ownership.epoch, since: this.ownership.since }),
    );
  }

  get state(): BrowserState {
    return browserState(this.options, this.ownership, {
      paused: this.paused,
      closed: this.closed,
      reason: this.reason,
      pageStateLost: this.pageStateLost,
      lastUrl: this.lastUrl,
      blocked: this.blocked,
    });
  }

  private emit(): void {
    this.options.state(this.state);
  }
  restorePrivate(): void {
    this.ownership.restorePrivate(this.options.now());
    this.paused = true;
    this.reason = "Private browser interrupted; explicit handback required";
    this.refs.invalidate();
    this.options.backend.privateMode?.(true);
    this.syncLease();
    this.emit();
  }
  takeover(connectionId: string, mode: "shared" | "private" = "shared"): BrowserState {
    if (this.closed) throw new BrowserActionError("browser_closed");
    if (!this.ownership.prepareTakeover(connectionId, mode)) return this.state;
    if (mode === "private") this.options.privatePaused?.();
    this.options.clearPageGrants?.();
    if (this.ownership.mode === "private" || mode === "private") this.refs.invalidate();
    this.ownership.takeover(connectionId, mode, this.options.now());
    this.options.backend.privateMode?.(mode === "private");
    if (this.paused && !this.pageStateLost) {
      this.paused = false;
      this.reason = undefined;
    }
    if (!this.paused) this.syncLease();
    this.emit();
    return this.state;
  }
  handback(connectionId: string): BrowserState {
    const wasPrivate = this.ownership.mode === "private";
    this.ownership.handback(connectionId, this.options.now());
    this.options.clearPageGrants?.();
    if (wasPrivate) this.refs.invalidate();
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
    if (this.ownership.owner !== connectionId) return;
    if (this.ownership.mode === "private") {
      this.ownership.owner = undefined;
      this.paused = true;
      this.reason = "Private takeover disconnected; explicit handback required";
      this.options.privatePaused?.();
      this.syncLease();
      this.emit();
    } else this.handback(connectionId);
  }
  private check(actor: Actor, signal?: AbortSignal, generation = this.ownership.generation): void {
    this.ownership.check(actor, { closed: this.closed, paused: this.paused }, signal, generation);
  }
  private readCheck(actor: Actor, epoch = this.ownership.epoch): void {
    this.ownership.read(actor, epoch);
  }
  changed(): void {
    this.queue.changed();
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
    return this.queue.run(work);
  }
  execute(raw: unknown, actor: Actor = { kind: "agent" }, signal?: AbortSignal): Promise<unknown> {
    const command = BrowserCommand.parse(raw);
    const submittedGeneration = this.ownership.generation;
    const privateEpoch = this.ownership.epoch;
    // Dialog answers cannot wait behind a renderer command paused by that dialog.
    if (command.action === "dialog")
      return (async () => {
        this.readCheck(actor, privateEpoch);
        this.check(actor, signal, submittedGeneration);
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
        return this.run(command, actor, signal, submittedGeneration);
      })();
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      this.readCheck(actor, privateEpoch);
      if (this.closed) throw new BrowserActionError("browser_closed");
      if (mutatesBrowser(command)) {
        this.check(actor, signal, submittedGeneration);
      }
      if (this.paused) throw new BrowserActionError("browser_paused");
      const generation = this.ownership.generation;
      if (mutatesBrowser(command)) {
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
      }
      // A dialog owns its original tab until answered, regardless of the requested tab.
      const pending_dialog = this.options.backend.tabs?.dialog();
      if (pending_dialog)
        return command.action === "tabs" && command.operation === "list"
          ? {
              activeTabId: this.options.backend.tabs?.active(),
              tabs: this.options.backend.tabs?.list(),
            }
          : { pending_dialog };
      await this.queue.drainDialog();
      this.readCheck(actor, privateEpoch);
      if (mutatesBrowser(command)) this.check(actor, signal, submittedGeneration);
      if (command.tabId && command.action !== "tabs") {
        this.check(actor, signal, submittedGeneration);
        await this.options.backend.tabs?.switch(command.tabId);
      }
      await this.syncTab();
      this.readCheck(actor, privateEpoch);
      if (command.tabId || mutatesBrowser(command)) this.check(actor, signal, submittedGeneration);
      let result: unknown;
      try {
        result = await this.queue.untilDialog(() =>
          this.run(command, actor, signal, submittedGeneration),
        );
      } catch (error) {
        if (error instanceof BrowserOriginError) this.blockedNavigation(error.blocked);
        throw error;
      }
      this.readCheck(actor, privateEpoch);
      if (this.paused || (generation !== this.ownership.generation && this.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return result;
    });
  }
  screenshot(signal?: AbortSignal, tabId?: string): Promise<Uint8Array> {
    const submittedGeneration = this.ownership.generation;
    const privateEpoch = this.ownership.epoch;
    return this.enqueue(() =>
      agentScreenshot(
        this.options.backend,
        () => this.syncTab(),
        {
          read: () => this.readCheck({ kind: "agent" }, privateEpoch),
          input: () => this.check({ kind: "agent" }, signal, submittedGeneration),
          ready: () => {
            if (this.closed) throw new BrowserActionError("browser_closed");
            if (this.paused) throw new BrowserActionError("browser_paused");
          },
          generation: () => this.ownership.generation,
          lost: () => this.pageStateLost,
          paused: () => this.paused,
        },
        signal,
        tabId,
      ),
    );
  }

  closeBy(actor: Actor, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.readCheck(actor);
    if (
      actor.kind === "agent" &&
      (this.ownership.controller === "human" || this.ownership.owner !== undefined)
    )
      throw new BrowserActionError(
        "human_controlled",
        "Browser controlled by human",
        "Wait for handback before closing.",
      );
    if (
      actor.kind === "human" &&
      this.ownership.owner !== undefined &&
      this.ownership.owner !== actor.connectionId
    )
      throw new Error("Browser controller mismatch");
    this.options.privateResumed?.();
    return this.close();
  }
  private run(
    command: BrowserCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<unknown> {
    const epoch = this.ownership.epoch;
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
      finishNavigation: () => {
        // A late approval belongs to the submitting lease, never to a takeover or handback.
        if (generation !== this.ownership.generation) this.options.clearPageGrants?.();
      },
      check: (...args) => this.check(...args),
      refDispatch: (ref) => this.refs.dispatch(ref, () => this.check(actor, signal, generation)),
      syncTab: () => this.syncTab(),
      emit: () => this.emit(),
      run: (...args) => this.run(...args),
      beginRecording: (check) => this.recordings.start(check),
      finishRecording: () => this.recordings.stop(),
    });
  }
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const generation = this.ownership.generation;
    return this.enqueue(async () => {
      this.check({ kind: "human", connectionId }, undefined, generation);
      await this.leaseReady;
      this.check({ kind: "human", connectionId }, undefined, generation);
      await sendHumanInput(input, this.options.backend.cdp, () =>
        this.check({ kind: "human", connectionId }, undefined, generation),
      );
    });
  }
  startRecording(): Promise<void> {
    const epoch = this.ownership.epoch;
    return this.enqueue(() =>
      this.recordings.start(() => this.readCheck({ kind: "agent" }, epoch)),
    );
  }
  stopRecording(): Promise<BrowserArtifact> {
    const epoch = this.ownership.epoch;
    return this.enqueue(() => {
      this.readCheck({ kind: "agent" }, epoch);
      return this.recordings.stop();
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lastUrl = this.options.backend.url();
      this.closed = true;
      this.options.cancelPolicy();
      this.ownership.controller = "none";
      this.ownership.owner = undefined;
      this.emit();
      await closeSession(this.options, this.live, this.queue, this.recordings, this.logs);
    })();
    return this.closing;
  }
}
