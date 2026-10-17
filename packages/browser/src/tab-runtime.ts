import {
  BrowserInput,
  type BrowserAnnotationEvent,
  type BrowserArtifact,
  type BrowserDialog,
  type BrowserOriginBlock,
  type BrowserState,
  type BrowserAgentPointer,
  type BrowserTabActor,
  type BrowserTabLifecycle,
} from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import { AnnotationSession } from "./annotation-session.ts";
import type { BrowserBackendPage, BrowserCdp, PopupTarget } from "./backend.ts";
import type { SessionLogs } from "./logs.ts";
import { PageIdentity } from "./page-identity.ts";
import { screenshotRegion } from "./page-capture.ts";
import { BrowserOriginError } from "./policy.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import { SnapshotRefs } from "./refs.ts";
import { executeBrowserCommand, type TabCommand } from "./session-commands.ts";
import { agentScreenshot } from "./session-images.ts";
import { sendHumanInput } from "./session-input.ts";
import type { Actor, SessionOptions } from "./session-options.ts";
import { SessionQueue, mutatesBrowser, type QueueBudget } from "./session-queue.ts";
import { TabAccess } from "./tab-access.ts";
import { agentInputDelay, waitsForPerson, type CollaborationTiming } from "./collaboration.ts";

/** What a tab needs from the thread browser that holds it. */
export interface TabHost {
  readonly options: SessionOptions;
  readonly logs: SessionLogs;
  readonly policies: NavigationPolicies;
  readonly budget: QueueBudget;
  readonly timing: CollaborationTiming;
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
  /** A tab became private or shared again; the backend hides or shows evidence. */
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
  private?: boolean | undefined;
}

/**
 * One tab: its own command queue, element refs and annotate mode. People and agents share it
 * (ADR 0067, "Collaboration"): the person's input bypasses the queue and lands at once; an
 * agent's page input waits while the person is busy here; a private tab admits no agent.
 * Commands on different tabs never wait for each other or touch each other's page.
 */
export class TabRuntime {
  readonly id: string;
  openedBy: BrowserTabActor | undefined;
  label: string | undefined;
  drivenBy: BrowserTabActor | undefined;
  lifecycle: BrowserTabLifecycle = "live";
  lastActiveAt: number;
  readonly access = new TabAccess();
  readonly refs: SnapshotRefs;
  readonly annotation: AnnotationSession;
  /** The page's own title and favicon, as the document reports them. */
  readonly identity: PageIdentity;
  /** When the person last used this tab (collaboration clock); -Infinity: never. */
  humanAt = -Infinity;
  private queue: SessionQueue;
  private host: TabHost;
  private closed = false;
  /** The person's own input runs in order, apart from agent commands. */
  private humanInput: Promise<unknown> = Promise.resolve();
  /** The agent using the tab, and how many of its commands are running. */
  private agent: BrowserTabActor | undefined;
  private agentAt = -Infinity;
  private agentRunning = 0;
  private stopInUse: (() => void) | undefined;
  private pointed: BrowserAgentPointer | undefined;
  /** The backend knows an agent uses the tab (file choosers, unseen rendering). */
  private agentShown = false;
  private agentSync: Promise<void> = Promise.resolve();
  constructor(host: TabHost, id: string, meta: TabMeta = {}) {
    this.host = host;
    this.id = id;
    this.openedBy = meta.openedBy;
    this.label = meta.label;
    this.lastActiveAt = meta.lastActiveAt ?? host.options.now();
    if (meta.private) this.access.setPrivate(true, host.options.now());
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
    this.identity = new PageIdentity(() => host.emit());
    this.watchIdentity();
  }
  /** Follow the title and favicon on the session that reaches the page now. */
  private watchIdentity(): void {
    let page: BrowserBackendPage;
    try {
      page = this.page;
    } catch {
      // A backend without per-tab pages reaches only the shown tab: its title is the backend's.
      return;
    }
    this.identity.watch(page.cdp);
  }
  get page(): BrowserBackendPage {
    return this.host.page(this.id);
  }
  /** Why the tab's renderer is down for good, until a navigation or reload revives it. */
  crashed(): string | undefined {
    try {
      return this.page.crashed?.();
    } catch {
      return undefined;
    }
  }
  /** A crashed tab answers nothing; only a command that loads a page again may run on it. */
  private crashCheck(command?: TabCommand): void {
    const revives =
      command?.action === "navigate" ||
      (command?.action === "history" && command.direction === "reload");
    if (!revives && this.crashed()) throw new BrowserActionError("tab_crashed");
  }
  get busy(): boolean {
    return !this.queue.idle;
  }
  get private(): boolean {
    return this.access.private;
  }
  /** The agent using this tab now: a command of its runs, or ran within `inUseMs`. */
  inUse(): BrowserTabActor | undefined {
    if (!this.agent || this.access.private) return undefined;
    const now = this.host.options.navigationClock.now();
    return this.agentRunning > 0 || now - this.agentAt < this.host.timing.inUseMs
      ? this.agent
      : undefined;
  }
  /** Where the agent using the tab last pointed, while it uses it. */
  pointer(): BrowserAgentPointer | undefined {
    return this.inUse() ? this.pointed : undefined;
  }
  /** The person used this tab within `window` ms. */
  humanWithin(window: number): boolean {
    return this.host.options.navigationClock.now() - this.humanAt < window;
  }
  settled(): Promise<unknown> {
    return this.queue.settled();
  }
  /** The page behind this tab changed (navigation, renderer restart, replaced backend). */
  invalidate(): void {
    this.refs.invalidate();
  }
  /** The tab's page was replaced; refs from the old page expire and the backend relearns. */
  rebind(): void {
    this.refs.invalidate();
    this.agentShown = false;
    this.syncAgent();
    this.watchIdentity();
  }
  restarted(): void {
    this.annotation.restarted(this.page.cdp);
    this.refs.invalidate();
    this.watchIdentity();
  }
  /** Dialog state changed on the page. */
  changed(): void {
    this.queue.changed();
  }
  /** In-flight work on a lost page must not complete as if nothing happened. */
  lost(): void {
    this.annotation.end("restart");
    this.access.generation++;
    this.refs.invalidate();
  }
  close(): Promise<unknown> {
    this.closed = true;
    this.stopInUse?.();
    this.identity.close();
    this.annotation.end("stopped");
    return this.queue.settled();
  }
  /**
   * Whether `actor` may act now. `epoch` is the privacy epoch its command started in: agent
   * work that began before the tab turned private never resumes, even once agents are let back.
   */
  check(
    actor: Actor,
    signal?: AbortSignal,
    generation = this.access.generation,
    epoch = this.access.epoch,
  ): void {
    const flags = this.host.flags();
    this.access.check(
      actor,
      { closed: flags.closed || this.closed, paused: flags.paused },
      signal,
      generation,
      epoch,
    );
  }
  readCheck(actor: Actor, epoch = this.access.epoch): void {
    this.access.read(actor, epoch);
  }
  /** "Keep agents out of this tab", or let them back in. Only a person may change it. */
  setPrivate(value: boolean): boolean {
    if (this.closed) throw new BrowserActionError("browser_closed");
    if (!this.access.setPrivate(value, this.host.options.now())) return false;
    this.refs.invalidate();
    if (value) {
      this.agent = undefined;
      this.pointed = undefined;
    }
    this.syncAgent();
    this.host.privacyChanged();
    return true;
  }
  /** Agents never act in a private tab; people always may. */
  admits(actor: Actor): boolean {
    return actor.kind === "human" || !this.access.private;
  }
  /** The person used the page directly (a native view the daemon does not route). */
  humanActivity(): void {
    this.humanAt = this.host.options.navigationClock.now();
    this.lastActiveAt = this.host.options.now();
  }
  private touch(actor: Actor): void {
    this.lastActiveAt = this.host.options.now();
    this.drivenBy =
      actor.kind === "agent"
        ? { kind: "agent", ...(actor.agentId ? { agentId: actor.agentId } : {}) }
        : { kind: "human" };
  }
  /** Marks the tab as used by this agent until its work ends and `inUseMs` passes. */
  private beginAgent(actor: Actor): () => void {
    if (actor.kind !== "agent") return () => {};
    const before = this.inUse();
    this.agent = { kind: "agent", ...(actor.agentId ? { agentId: actor.agentId } : {}) };
    this.agentRunning++;
    this.agentAt = this.host.options.navigationClock.now();
    this.stopInUse?.();
    this.stopInUse = undefined;
    if (before?.agentId !== this.agent.agentId || !before) this.host.emit();
    this.syncAgent();
    return () => {
      this.agentRunning--;
      this.agentAt = this.host.options.navigationClock.now();
      if (this.agentRunning > 0 || this.closed) return;
      this.stopInUse?.();
      this.stopInUse = this.host.options.navigationClock.set(this.host.timing.inUseMs, () => {
        this.stopInUse = undefined;
        if (this.closed || this.inUse()) return;
        this.syncAgent();
        this.host.emit();
      });
    };
  }
  /** Tell the backend whether an agent uses the tab; it may run ahead of the agent's input. */
  private syncAgent(): void {
    const active = this.inUse() !== undefined;
    if (active === this.agentShown) return;
    this.agentShown = active;
    const backend = this.host.options.backend;
    if (!backend.agentUse) return;
    this.agentSync = backend.agentUse(this.id, active).catch(() => {});
  }
  /** An agent pointed here (click, hover, drag); viewers draw its cursor gliding there. */
  private point(actor: Actor, point: { x: number; y: number }): void {
    if (actor.kind !== "agent") return;
    this.pointed = {
      x: Math.round(point.x),
      y: Math.round(point.y),
      sequence: (this.pointed?.sequence ?? 0) + 1,
    };
    this.host.emit();
  }
  /**
   * An agent's page input waits while the person is busy in this tab: it runs once they have
   * paused for `quietMs`, or fails with `human_active` after `maxWaitMs`.
   */
  private async personIdle(signal?: AbortSignal): Promise<void> {
    const clock = this.host.options.navigationClock;
    const since = clock.now();
    for (;;) {
      signal?.throwIfAborted();
      const delay = agentInputDelay(clock.now(), this.humanAt, since, this.host.timing);
      if (delay === "give_up") throw new BrowserActionError("human_active");
      if (delay === 0) return;
      await new Promise<void>((resolve) => {
        const cancel = clock.set(delay, finish);
        signal?.addEventListener("abort", finish, { once: true });
        function finish() {
          cancel();
          signal?.removeEventListener("abort", finish);
          resolve();
        }
      });
    }
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
    try {
      this.readCheck(actor);
    } catch (error) {
      return Promise.reject(error);
    }
    this.touch(actor);
    const end = this.beginAgent(actor);
    const work = this.submitted(command, actor, signal, target);
    void work.then(end, end);
    return work;
  }
  private submitted(
    command: TabCommand,
    actor: Actor,
    signal?: AbortSignal,
    target?: PopupTarget,
  ): Promise<unknown> {
    const checkTarget = () => {
      if (target && !target.current()) throw new BrowserActionError("backend_changed");
    };
    const submittedGeneration = this.access.generation;
    const privateEpoch = this.access.epoch;
    // Dialog answers cannot wait behind a renderer command paused by that dialog.
    if (
      command.action === "dialog" ||
      (command.action === "history" && command.direction === "stop")
    )
      return (async () => {
        this.readCheck(actor, privateEpoch);
        this.check(actor, signal, submittedGeneration);
        return this.run(command, actor, signal, submittedGeneration);
      })();
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      checkTarget();
      this.readCheck(actor, privateEpoch);
      const flags = this.host.flags();
      if (flags.closed || this.closed) throw new BrowserActionError("browser_closed");
      if (mutatesBrowser(command)) this.check(actor, signal, submittedGeneration, privateEpoch);
      if (flags.paused) throw new BrowserActionError("browser_paused");
      const generation = this.access.generation;
      // A dialog owns its tab until answered; other tabs keep working.
      const pending_dialog = this.host.dialog(this.id);
      if (pending_dialog) return { pending_dialog };
      await this.queue.drainDialog();
      if (actor.kind === "agent" && waitsForPerson(command)) {
        await this.personIdle(signal);
        await this.agentSync;
      }
      await this.host.wake(this.id);
      this.readCheck(actor, privateEpoch);
      if (mutatesBrowser(command)) this.check(actor, signal, submittedGeneration, privateEpoch);
      this.crashCheck(command);
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
      if (after.paused || (generation !== this.access.generation && after.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return result;
    });
  }
  screenshot(
    actor: Actor,
    signal?: AbortSignal,
    options: { fullPage?: boolean | undefined; ref?: string | undefined } = {},
  ): Promise<Uint8Array> {
    try {
      this.readCheck(actor);
    } catch (error) {
      return Promise.reject(error);
    }
    this.touch(actor);
    const end = this.beginAgent(actor);
    const privateEpoch = this.access.epoch;
    const work = this.enqueue(async () => {
      await this.host.wake(this.id);
      this.crashCheck();
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
          generation: () => this.access.generation,
          lost: () => this.host.flags().pageStateLost,
          paused: () => this.host.flags().paused,
        },
        signal,
      );
    });
    void work.then(end, end);
    return work;
  }
  /**
   * The person's own input: never queued behind agent commands and never refused for agent
   * activity. It runs in order with the person's earlier input.
   */
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const actor: Actor = { kind: "human", connectionId };
    this.touch(actor);
    this.humanActivity();
    if (this.closed || this.host.flags().closed)
      return Promise.reject(new BrowserActionError("browser_closed"));
    const generation = this.access.generation;
    const work = this.humanInput.then(async () => {
      this.check(actor, undefined, generation);
      await sendHumanInput(input, this.page.cdp, () => this.check(actor, undefined, generation));
    });
    this.humanInput = work.catch(() => {});
    return work;
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
    const epoch = this.access.epoch;
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
      check: (who, checkSignal, checkGeneration) =>
        this.check(who, checkSignal, checkGeneration, epoch),
      refDispatch: (ref) =>
        this.refs.dispatch(ref, () => this.check(actor, signal, generation, epoch)),
      point: (point) => this.point(actor, point),
      emit: () => host.emit(),
      run: (...args) => this.run(...args),
      beginRecording: (check) => host.beginRecording(check),
      finishRecording: () => host.finishRecording(),
    });
  }
}
