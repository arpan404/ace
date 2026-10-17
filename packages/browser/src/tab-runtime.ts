import {
  BrowserInput,
  type BrowserAnnotationEvent,
  type BrowserArtifact,
  type BrowserDialog,
  type BrowserOriginBlock,
  type BrowserState,
  type BrowserTabActor,
  type BrowserTabLease,
  type BrowserTabLifecycle,
} from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import { AnnotationSession } from "./annotation-session.ts";
import type { BrowserBackendPage, BrowserCdp, PopupTarget } from "./backend.ts";
import type { SessionLogs } from "./logs.ts";
import { screenshotRegion } from "./page-capture.ts";
import { BrowserOriginError } from "./policy.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import { SnapshotRefs } from "./refs.ts";
import { executeBrowserCommand, type TabCommand } from "./session-commands.ts";
import { agentScreenshot } from "./session-images.ts";
import { sendHumanInput } from "./session-input.ts";
import type { Actor, SessionOptions } from "./session-options.ts";
import { SessionOwnership } from "./session-ownership.ts";
import { SessionQueue, mutatesBrowser, type QueueBudget } from "./session-queue.ts";

/** What a tab needs from the thread browser that holds it. */
export interface TabHost {
  readonly options: SessionOptions;
  readonly logs: SessionLogs;
  readonly policies: NavigationPolicies;
  readonly budget: QueueBudget;
  page(tabId: string): BrowserBackendPage;
  /** Thread-wide facts every check reads. */
  flags(): { closed: boolean; paused: boolean; pageStateLost: boolean };
  dialog(tabId: string): BrowserDialog | undefined;
  answer(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
  blocked(): BrowserOriginBlock | undefined;
  blockedNavigation(blocked: BrowserOriginBlock): void;
  clearBlocked(): void;
  state(): BrowserState;
  emit(): void;
  /** A lease the backend could not apply pauses the thread's browser. */
  suspend(reason: string): void;
  /** A paused browser whose pages survived resumes when control changes hands. */
  resumeIntact(): void;
  /** Persist private ownership before it is granted, and keep it through a disconnect. */
  privatePaused(): void;
  /** Private control on some tab ended or began; the backend hides or shows evidence. */
  privacyChanged(): void;
  /** Bring a frozen tab back before work runs on it. */
  wake(tabId: string): Promise<void>;
  beginRecording(check: () => void): Promise<void>;
  finishRecording(): Promise<BrowserArtifact>;
  annotation(connectionId: string, event: BrowserAnnotationEvent): void;
}
export interface TabMeta {
  openedBy?: BrowserTabActor | undefined;
  label?: string | undefined;
  lastActiveAt?: number | undefined;
}

/**
 * One tab: its own command queue, element refs, annotate mode and control lease. Commands on
 * different tabs never wait for each other or touch each other's page.
 */
export class TabRuntime {
  readonly id: string;
  openedBy: BrowserTabActor | undefined;
  label: string | undefined;
  drivenBy: BrowserTabActor | undefined;
  lifecycle: BrowserTabLifecycle = "live";
  lastActiveAt: number;
  ownership: SessionOwnership;
  readonly refs: SnapshotRefs;
  readonly annotation: AnnotationSession;
  private queue: SessionQueue;
  private leaseReady: Promise<void> = Promise.resolve();
  private host: TabHost;
  private closed = false;
  constructor(host: TabHost, id: string, meta: TabMeta = {}, ownership = new SessionOwnership()) {
    this.host = host;
    this.id = id;
    this.openedBy = meta.openedBy;
    this.label = meta.label;
    this.lastActiveAt = meta.lastActiveAt ?? host.options.now();
    this.ownership = ownership;
    this.queue = new SessionQueue(() => host.dialog(id), host.budget);
    this.annotation = new AnnotationSession(
      (connectionId, event) => host.annotation(connectionId, event),
      () => host.emit(),
    );
    // Resolved on use: a backend without per-tab pages can only reach the tab it shows.
    const cdp: BrowserCdp = {
      send: (method, params) => this.page.cdp.send(method, params),
      on: (method, listener) => this.page.cdp.on(method, listener),
      off: (method, listener) => this.page.cdp.off(method, listener),
    };
    this.refs = new SnapshotRefs(
      cdp,
      () => this.page.frames?.(),
      () => this.annotation.hostNode(),
    );
  }
  get page(): BrowserBackendPage {
    return this.host.page(this.id);
  }
  get busy(): boolean {
    return !this.queue.idle;
  }
  get private(): boolean {
    return this.ownership.mode === "private";
  }
  lease(): BrowserTabLease {
    return {
      controller: this.host.flags().paused ? "none" : this.ownership.controller,
      ...(this.ownership.owner ? { owner: this.ownership.owner } : {}),
      mode: this.ownership.mode,
    };
  }
  settled(): Promise<unknown> {
    return this.queue.settled();
  }
  /** The page behind this tab changed (navigation, renderer restart, replaced backend). */
  invalidate(): void {
    this.refs.invalidate();
  }
  /** The tab's page was replaced; refs from the old page expire. */
  rebind(): void {
    this.refs.invalidate();
  }
  restarted(): void {
    this.annotation.restarted(this.page.cdp);
    this.refs.invalidate();
  }
  /** Dialog state changed on the page. */
  changed(): void {
    this.queue.changed();
  }
  /** In-flight work on a lost page must not complete as if nothing happened. */
  lost(): void {
    this.annotation.end("restart");
    this.ownership.generation++;
    this.refs.invalidate();
  }
  close(): Promise<unknown> {
    this.closed = true;
    this.annotation.end("stopped");
    return this.queue.settled();
  }
  check(actor: Actor, signal?: AbortSignal, generation = this.ownership.generation): void {
    const flags = this.host.flags();
    this.ownership.check(
      actor,
      { closed: flags.closed || this.closed, paused: flags.paused },
      signal,
      generation,
    );
  }
  readCheck(actor: Actor, epoch = this.ownership.epoch): void {
    this.ownership.read(actor, epoch);
  }
  /** Applies this tab's lease in the backend; a failure pauses the thread's browser. */
  syncLease(): Promise<void> {
    const lease = this.ownership.lease();
    this.leaseReady = this.host.options.backend.controller(lease, this.id);
    void this.leaseReady.catch((error) => {
      if (lease.generation === this.ownership.generation)
        this.host.suspend(error instanceof Error ? error.message : "Controller lease failed");
    });
    return this.leaseReady;
  }
  restorePrivate(): void {
    this.ownership.restorePrivate(this.host.options.now());
    this.refs.invalidate();
    this.host.privacyChanged();
    void this.syncLease();
  }
  takeover(connectionId: string, mode: "shared" | "private"): void {
    if (this.closed) throw new BrowserActionError("browser_closed");
    if (!this.ownership.prepareTakeover(connectionId, mode)) return;
    if (mode === "private") this.host.privatePaused();
    if (this.ownership.mode === "private" || mode === "private") this.refs.invalidate();
    this.ownership.takeover(connectionId, mode, this.host.options.now());
    this.host.privacyChanged();
    this.host.resumeIntact();
    if (!this.host.flags().paused) void this.syncLease();
  }
  handback(connectionId: string): void {
    if (this.ownership.owner === connectionId) this.annotation.end("lease");
    const wasPrivate = this.ownership.mode === "private";
    this.ownership.handback(connectionId, this.host.options.now());
    if (wasPrivate) this.refs.invalidate();
    this.host.privacyChanged();
    this.host.resumeIntact();
    if (!this.host.flags().paused) void this.syncLease();
  }
  /** Returns true when the connection held this tab privately and the tab now waits for it. */
  disconnect(connectionId: string): boolean {
    if (this.annotation.owner === connectionId) this.annotation.end("disconnect");
    if (this.ownership.owner !== connectionId) return false;
    if (this.ownership.mode !== "private") {
      this.handback(connectionId);
      return false;
    }
    this.ownership.owner = undefined;
    this.host.privatePaused();
    void this.syncLease();
    return true;
  }
  /** Agents may not drive a tab a person holds; agents may not even see a private one. */
  admits(actor: Actor): boolean {
    if (actor.kind === "human") return true;
    return this.ownership.controller === "agent" && this.ownership.mode !== "private";
  }
  private touch(actor: Actor): void {
    this.lastActiveAt = this.host.options.now();
    this.drivenBy =
      actor.kind === "agent"
        ? { kind: "agent", ...(actor.agentId ? { agentId: actor.agentId } : {}) }
        : { kind: "human" };
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.host.flags().closed)
      return Promise.reject(new BrowserActionError("browser_closed"));
    return this.queue.run(work);
  }
  submit(
    command: TabCommand,
    actor: Actor,
    signal?: AbortSignal,
    target?: PopupTarget,
  ): Promise<unknown> {
    this.touch(actor);
    const checkTarget = () => {
      if (target && !target.current()) throw new BrowserActionError("backend_changed");
    };
    const submittedGeneration = this.ownership.generation;
    const privateEpoch = this.ownership.epoch;
    // Dialog answers cannot wait behind a renderer command paused by that dialog.
    if (
      command.action === "dialog" ||
      (command.action === "history" && command.direction === "stop")
    )
      return (async () => {
        this.readCheck(actor, privateEpoch);
        this.check(actor, signal, submittedGeneration);
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
        return this.run(command, actor, signal, submittedGeneration);
      })();
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      checkTarget();
      this.readCheck(actor, privateEpoch);
      const flags = this.host.flags();
      if (flags.closed || this.closed) throw new BrowserActionError("browser_closed");
      if (mutatesBrowser(command)) this.check(actor, signal, submittedGeneration);
      if (flags.paused) throw new BrowserActionError("browser_paused");
      const generation = this.ownership.generation;
      if (mutatesBrowser(command)) {
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
      }
      // A dialog owns its tab until answered; other tabs keep working.
      const pending_dialog = this.host.dialog(this.id);
      if (pending_dialog) return { pending_dialog };
      await this.queue.drainDialog();
      await this.host.wake(this.id);
      this.readCheck(actor, privateEpoch);
      if (mutatesBrowser(command)) this.check(actor, signal, submittedGeneration);
      let result: unknown;
      try {
        result = await this.queue.untilDialog(() =>
          this.run(command, actor, signal, submittedGeneration, checkTarget, target?.navigate),
        );
      } catch (error) {
        if (error instanceof BrowserOriginError) this.host.blockedNavigation(error.blocked);
        throw error;
      }
      this.readCheck(actor, privateEpoch);
      const after = this.host.flags();
      if (after.paused || (generation !== this.ownership.generation && after.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return result;
    });
  }
  screenshot(
    actor: Actor,
    signal?: AbortSignal,
    options: { fullPage?: boolean | undefined; ref?: string | undefined } = {},
  ): Promise<Uint8Array> {
    this.touch(actor);
    const privateEpoch = this.ownership.epoch;
    return this.enqueue(async () => {
      await this.host.wake(this.id);
      return agentScreenshot(
        this.page,
        () => screenshotRegion(options, this.refs, () => this.readCheck(actor, privateEpoch)),
        {
          read: () => this.readCheck(actor, privateEpoch),
          ready: () => {
            const flags = this.host.flags();
            if (flags.closed || this.closed) throw new BrowserActionError("browser_closed");
            if (flags.paused) throw new BrowserActionError("browser_paused");
          },
          generation: () => this.ownership.generation,
          lost: () => this.host.flags().pageStateLost,
          paused: () => this.host.flags().paused,
        },
        signal,
      );
    });
  }
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const actor: Actor = { kind: "human", connectionId };
    const generation = this.ownership.generation;
    this.touch(actor);
    return this.enqueue(async () => {
      this.check(actor, undefined, generation);
      await this.leaseReady;
      this.check(actor, undefined, generation);
      await sendHumanInput(input, this.page.cdp, () => this.check(actor, undefined, generation));
    });
  }
  /** Thread-level work (recording) that must wait its turn behind this tab's commands. */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }
  private run(
    command: TabCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
    beforeInput?: () => void,
    navigate?: () => Promise<void>,
  ): Promise<unknown> {
    const epoch = this.ownership.epoch;
    const host = this.host;
    return executeBrowserCommand(command, actor, signal, generation, {
      options: host.options,
      tabId: this.id,
      page: this.page,
      answer: (dialogId, accept, promptText) => host.answer(dialogId, accept, promptText),
      beforeInput,
      navigate,
      refs: this.refs,
      annotation: this.annotation,
      logs: host.logs,
      policies: host.policies,
      state: () => host.state(),
      read: () => this.readCheck(actor, epoch),
      blocked: () => host.blocked(),
      clearBlocked: () => host.clearBlocked(),
      check: (...args) => this.check(...args),
      refDispatch: (ref) => this.refs.dispatch(ref, () => this.check(actor, signal, generation)),
      emit: () => host.emit(),
      run: (...args) => this.run(...args),
      beginRecording: (check) => host.beginRecording(check),
      finishRecording: () => host.finishRecording(),
    });
  }
}
