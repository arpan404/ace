import {
  BrowserInput,
  type BrowserAnnotationEvent,
  type BrowserArtifact,
  type BrowserDialog,
  type BrowserOriginBlock,
  type BrowserState,
  type BrowserAgentPointer,
  type BrowserTab,
  type BrowserTabActor,
  type BrowserTabLifecycle,
  type BrowserPageState,
} from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import { AnnotationSession } from "./annotation-session.ts";
import type { BrowserBackendPage, BrowserCdp, PopupTarget } from "./backend.ts";
import type { SessionLogs } from "./logs.ts";
import { PageIdentity } from "./page-identity.ts";
import { PageHistory } from "./page-history.ts";
import { screenshotRegion } from "./page-capture.ts";
import { BrowserOriginError } from "./policy.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import { SnapshotRefs } from "./refs.ts";
import { executeBrowserCommand, type TabCommand } from "./session-commands.ts";
import type { TabView } from "./page-tools.ts";
import { agentScreenshot, type AgentScreenshot } from "./session-images.ts";
import { sendHumanInput } from "./session-input.ts";
import { TouchPinch } from "./touch-pinch.ts";
import type { Actor, SessionOptions } from "./session-options.ts";
import { SessionQueue, mutatesBrowser, type QueueBudget, type TabHold } from "./session-queue.ts";
import { personHold, refusesAgent } from "./person-holds.ts";
import { nextZoom, zoomChord, type ZoomStep } from "./zoom.ts";
import { TabAccess } from "./tab-access.ts";
import { waitsForPerson, type CollaborationTiming } from "./collaboration.ts";
import { AgentInputLane, personReturned } from "./agent-input-lane.ts";
import { fillFieldByField } from "./typing.ts";
import { PageCursor } from "./page-cursor.ts";
import { PageInteraction } from "./page-interaction.ts";
import { defaultCursorStyle } from "@ace/browser-annotate";

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
  /** The backend's listing of this tab: what it waits on (a sign-in, a certificate warning). */
  listed(tabId: string): BrowserTab | undefined;
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
  /** `by` starts recording this tab (`tabId`), whichever tab the person views. */
  beginRecording(tabId: string, check: () => void, by: Actor): Promise<void>;
  finishRecording(): Promise<BrowserArtifact>;
  annotation(connectionId: string, event: BrowserAnnotationEvent): void;
  /** An agent recording runs in this browser: new tabs start hidden and masked too. */
  recording?(): boolean;
  /** The tab's page state for remote views changed (`browser.page`). */
  pageState?(tabId: string, page: BrowserPageState): void;
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
  /** Whether Back and Forward lead anywhere, kept current through every navigation. */
  readonly history: PageHistory;
  /** The device the tab emulates and its zoom, as the last command set them. */
  readonly view: TabView = { emulation: undefined, zoom: 1 };
  /** The person's two-finger spread in the current touch sequence. */
  private readonly pinch = new TouchPinch();
  /** Agents' cursors drawn in the page, and the mask over secret fields in captures. */
  readonly cursor: PageCursor;
  /**
   * The focused field, open picker, cursor shape and tooltip a remote view draws. Only ace's
   * own headless pages have it: elsewhere the person uses the page's own pickers natively.
   */
  readonly interaction: PageInteraction | undefined;
  /** When the person last used this tab (collaboration clock); -Infinity: never. */
  humanAt = -Infinity;
  /**
   * The person used the page this tab shows now (input, or a command of theirs) since it last
   * changed: its unsaved changes may be theirs, so only they may agree to discard them.
   */
  private personDocument = false;
  private queue: SessionQueue;
  /** Agent input waiting for the person, outside the queue so reads never wait behind it. */
  private lane: AgentInputLane;
  private host: TabHost;
  private closed = false;
  /**
   * The person's lane: their own input and annotate-mode commands run here in order, apart
   * from agent commands. Agent input that waits for the person has its own lane (`lane`).
   */
  private personLane: Promise<unknown> = Promise.resolve();
  /** The agent using the tab, and how many of its commands are running. */
  private agent: BrowserTabActor | undefined;
  private agentAt = -Infinity;
  private agentRunning = 0;
  private stopInUse: (() => void) | undefined;
  private pointed: BrowserAgentPointer | undefined;
  /** The backend knows an agent uses the tab (file choosers, unseen rendering). */
  private agentShown = false;
  private agentSync: Promise<void> = Promise.resolve();
  private popups: { tabId: string; url: string }[] = [];
  constructor(host: TabHost, id: string, meta: TabMeta = {}) {
    this.host = host;
    this.id = id;
    this.openedBy = meta.openedBy;
    this.label = meta.label;
    this.lastActiveAt = meta.lastActiveAt ?? host.options.now();
    if (meta.private) this.access.setPrivate(true, host.options.now());
    this.queue = new SessionQueue(() => this.held(), host.budget);
    this.lane = new AgentInputLane(host.options.navigationClock, host.timing, () => this.humanAt);
    this.annotation = new AnnotationSession(
      (connectionId, event) => host.annotation(connectionId, event),
      () => host.emit(),
      (delay, work) => host.options.navigationClock.set(delay, work),
    );
    // Resolved on use: a backend without per-tab pages can only reach the tab it shows.
    const cdp: BrowserCdp = {
      send: (method, params) => this.page.cdp.send(method, params),
      on: (method, listener) => this.page.cdp.on(method, listener),
      off: (method, listener) => this.page.cdp.off(method, listener),
    };
    const cursor = host.options.cursor;
    this.cursor = new PageCursor(() => this.page.cdp, {
      visible: cursor?.visible ?? false,
      glideMs: cursor?.glideMs ?? 0,
      inUseMs: host.timing.inUseMs,
      quietMs: host.timing.quietMs,
      clock: host.options.navigationClock,
      style: () => cursor?.style() ?? defaultCursorStyle,
      name: (agentId) => cursor?.name?.(agentId),
    });
    if (host.recording?.()) void this.cursor.setRecording(true);
    this.refs = new SnapshotRefs(
      cdp,
      () => this.page.frames?.(),
      async () => [await this.annotation.hostNode(), await this.cursor.hostNode()],
    );
    this.identity = new PageIdentity(() => host.emit());
    this.interaction =
      host.options.backendKind === "headless"
        ? new PageInteraction(
            (page) => host.pageState?.(id, page),
            () => `${id}-picker-${host.options.id()}`,
          )
        : undefined;
    this.history = new PageHistory(() => host.emit(), host.options.navigationClock);
    this.watchIdentity();
  }
  /** The page identity waits for a command to claim the tab (`watchIdentity`). */
  private identityWaits = false;
  /** Follow the title, favicon and history on the session that reaches the page now. */
  private watchIdentity(): void {
    let page: BrowserBackendPage;
    try {
      page = this.page;
    } catch {
      // A backend without per-tab pages reaches only the shown tab: its title is the backend's.
      return;
    }
    // A shared tab of the person's Chrome is claimed by its first command, not by watching it;
    // until then its title is the one their Chrome lists.
    this.identityWaits = page.unclaimed?.() === true;
    if (this.identityWaits) return;
    this.identity.watch(page.cdp);
    this.history.watch(page.cdp);
    this.interaction?.watch(page.cdp);
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
    return !this.queue.idle || !this.lane.idle;
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
    return Promise.all([this.lane.settled(), this.queue.settled()]);
  }
  /** The page behind this tab changed (navigation, renderer restart, replaced backend). */
  invalidate(): void {
    this.refs.invalidate();
    this.personDocument = false;
  }
  /** An agent's command may leave the page unasked: the person has not used it since it loaded. */
  leaveUnasked(): boolean {
    return this.agentRunning > 0 && !this.personDocument && !this.access.private;
  }
  /** The tab's page was replaced; refs from the old page expire and the backend relearns. */
  rebind(): void {
    this.refs.invalidate();
    this.cursor.rebind();
    this.agentShown = false;
    this.syncAgent();
    this.watchIdentity();
  }
  restarted(): void {
    this.annotation.restarted(this.page.cdp);
    this.cursor.rebind();
    this.refs.restarted();
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
    this.lane.close();
    this.stopInUse?.();
    this.identity.close();
    this.history.close();
    this.interaction?.close();
    this.annotation.end("stopped");
    this.cursor.close();
    return this.settled();
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
    this.cursor.setPrivate(value);
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
    this.personDocument = true;
    this.humanAt = this.host.options.navigationClock.now();
    this.lastActiveAt = this.host.options.now();
    this.cursor.personActed();
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
    if (
      actor.kind === "human" &&
      (command.action === "annotate" || command.action === "annotate_capture")
    )
      return this.annotate(command, actor, signal);
    // The person's own navigation or edit: leaving this page is for them to agree to.
    if (actor.kind === "human" && mutatesBrowser(command)) this.personDocument = true;
    const end = this.beginAgent(actor);
    const work = this.submitted(command, actor, signal, target);
    void work.then(end, end);
    return work;
  }
  /**
   * Annotate mode is the person's (ADR 0082, ADR 0067 "Collaboration"): its commands run on
   * the person's lane, never behind agent commands. They run in order with the person's input,
   * so the images the client asks for before stopping still see the markers.
   */
  private annotate(command: TabCommand, actor: Actor, signal?: AbortSignal): Promise<unknown> {
    const generation = this.access.generation;
    const work = this.personLane.then(async () => {
      // Stopping always works: nothing may keep the overlay on the page.
      if (command.action === "annotate" && command.operation === "stop")
        return this.run(command, actor, signal, generation);
      this.check(actor, signal, generation);
      this.crashCheck(command);
      const pending_dialog = this.host.dialog(this.id);
      if (pending_dialog) return { pending_dialog };
      await this.host.wake(this.id);
      return this.run(command, actor, signal, generation);
    });
    this.personLane = work.catch(() => {});
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
        if (command.action === "dialog") this.leaveCheck(command, actor);
        return this.run(command, actor, signal, submittedGeneration);
      })();
    // The person's Back and Forward land at once, as in any browser: never behind an agent's
    // slow command or a page dialog in this tab (the engine decides what the dialog does).
    if (
      actor.kind === "human" &&
      command.action === "history" &&
      (command.direction === "back" || command.direction === "forward")
    )
      return (async () => {
        this.readCheck(actor, privateEpoch);
        this.check(actor, signal, submittedGeneration);
        await this.host.wake(this.id);
        this.crashCheck(command);
        return this.run(command, actor, signal, submittedGeneration);
      })();
    const waits = actor.kind === "agent" && waitsForPerson(command);
    // One queue turn for a command, or for one step of it (a field of an agent's fill_form).
    const jobFor = (part: TabCommand) => async () => {
      signal?.throwIfAborted();
      checkTarget();
      this.readCheck(actor, privateEpoch);
      const flags = this.host.flags();
      if (flags.closed || this.closed) throw new BrowserActionError("browser_closed");
      if (mutatesBrowser(part)) this.check(actor, signal, submittedGeneration, privateEpoch);
      if (flags.paused) throw new BrowserActionError("browser_paused");
      const generation = this.access.generation;
      // A dialog or a sign-in owns its tab until answered; other tabs keep working.
      const held = this.held(command);
      if (held) return held;
      if (actor.kind === "agent" && refusesAgent(this.host.listed(this.id), command))
        throw new BrowserActionError("needs_person");
      await this.queue.drainDialog();
      if (waits) {
        // The person came back while this input waited for its turn: it waits again, outside.
        if (!this.lane.quiet()) return personReturned;
        await this.agentSync;
      }
      await this.host.wake(this.id);
      this.readCheck(actor, privateEpoch);
      if (mutatesBrowser(part)) this.check(actor, signal, submittedGeneration, privateEpoch);
      this.crashCheck(part);
      let result: unknown;
      try {
        result = await this.queue.untilDialog(() =>
          this.run(part, actor, signal, submittedGeneration, checkTarget, target?.navigate),
        );
      } catch (error) {
        if (error instanceof BrowserOriginError) this.host.blockedNavigation(error.blocked);
        throw error;
      }
      // The command claimed a shared tab: its title and favicon can be watched now.
      if (this.identityWaits) this.watchIdentity();
      this.readCheck(actor, privateEpoch);
      const after = this.host.flags();
      if (after.paused || (generation !== this.access.generation && after.pageStateLost))
        throw new BrowserActionError("backend_changed");
      return actor.kind === "agent" ? this.popupsInto(result) : result;
    };
    // An agent's input waits for the person in its own lane, so reads never queue behind it.
    if (waits && command.action === "fill_form")
      return this.lane.run(signal, (step) =>
        fillFieldByField(command.fields, (field) => step(() => this.enqueue(jobFor(field)))),
      );
    if (waits) return this.lane.run(signal, (step) => step(() => this.enqueue(jobFor(command))));
    return this.enqueue(jobFor(command));
  }
  screenshot(
    actor: Actor,
    signal?: AbortSignal,
    options: { fullPage?: boolean | undefined; ref?: string | undefined } = {},
  ): Promise<AgentScreenshot> {
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
      return this.cursor.capture(() =>
        agentScreenshot(
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
        ),
      );
    });
    void work.then(end, end);
    return work;
  }
  /**
   * The person's own input: never queued behind agent commands and never refused for agent
   * activity. It runs on the person's lane, in order with their earlier input.
   */
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const actor: Actor = { kind: "human", connectionId };
    this.touch(actor);
    this.humanActivity();
    if (this.closed || this.host.flags().closed)
      return Promise.reject(new BrowserActionError("browser_closed"));
    const generation = this.access.generation;
    const zoom = this.page.zoom ? zoomChord(input) : undefined;
    const work = this.personLane.then(async () => {
      this.check(actor, undefined, generation);
      // ⌘+ / ⌘- / ⌘0 zoom the page, as in a browser; the page never sees them.
      if (zoom) {
        if (input.kind === "key" && input.event === "keyDown") await this.zoomStep(zoom);
        return;
      }
      if (input.kind === "pick") {
        if (!this.interaction) throw new BrowserActionError("not_supported");
        await this.interaction.pick(input.pickerId, input.values);
        return;
      }
      await sendHumanInput(
        input,
        this.page.cdp,
        () => this.check(actor, undefined, generation),
        this.pinch,
      );
    });
    this.personLane = work.catch(() => {});
    return work;
  }
  /**
   * An agent may not agree to leave a page the person was using: that would discard their
   * unsaved changes. It may still choose to stay.
   */
  private leaveCheck(command: { dialogId: string; accept: boolean }, actor: Actor): void {
    if (actor.kind !== "agent" || !command.accept || !this.personDocument) return;
    const pending = this.host.dialog(this.id);
    if (pending?.dialogId === command.dialogId && pending.type === "beforeunload")
      throw new BrowserActionError("unsaved_changes");
  }
  /** The person's ⌘+ / ⌘- / ⌘0 in a screencast view: one zoom step, kept like the zoom command's. */
  private async zoomStep(step: ZoomStep): Promise<void> {
    const next = nextZoom(this.view.zoom, step);
    await this.page.zoom?.(next);
    this.view.zoom = next;
    this.host.emit();
  }
  /**
   * This tab's page opened a window it talks to (an OAuth sign-in, say); it is now a tab of the
   * thread. The next agent result from this tab says so once.
   */
  popupOpened(popup: { tabId: string; url: string }): void {
    if (this.popups.length < 8) this.popups.push(popup);
  }
  private popupsInto(result: unknown): unknown {
    if (!this.popups.length || Array.isArray(result)) return result;
    const popups_opened = this.popups.splice(0);
    const notice = {
      popups_opened,
      popup_hint:
        "This page opened a window it needs (often a sign-in). Act in it with its tabId; a sign-in there may need the person.",
    };
    return typeof result === "object" && result !== null ? { ...result, ...notice } : notice;
  }
  /** What holds this tab until it is answered; `command` may be one that leaves the page. */
  private held(command?: TabCommand): TabHold | undefined {
    const pending_dialog = this.host.dialog(this.id);
    if (pending_dialog) return { pending_dialog };
    return personHold(this.host.listed(this.id), command);
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
      view: this.view,
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
      personPresent: () => this.humanWithin(host.timing.presentMs),
      personBusy: () => actor.kind === "agent" && !this.lane.quiet(),
      point: (point) => this.point(actor, point),
      cursor:
        actor.kind === "agent" && this.cursor.visible
          ? {
              point: (at, click) => this.cursor.point(actor.agentId, at, click),
              drag: (from, to) => this.cursor.drag(actor.agentId, from, to),
              typing: (field) => this.cursor.typing(actor.agentId, field),
              scroll: (dx, dy) => this.cursor.scroll(actor.agentId, dx, dy),
            }
          : undefined,
      capture: (work) => this.cursor.capture(work),
      emit: () => host.emit(),
      run: (...args) => this.run(...args),
      beginRecording: (check, by) => host.beginRecording(this.id, check, by),
      finishRecording: () => host.finishRecording(),
    });
  }
}
