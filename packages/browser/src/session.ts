import { NavigationPolicies } from "./policy-waits.ts";
import { BrowserActionError } from "./action-error.ts";
import type { BackendLog, BrowserBackendSession, PopupTarget } from "./backend.ts";
import type { BrowserAnnotationEvent, BrowserOriginBlock } from "@ace/protocol";
import { BrowserCommand, type BrowserArtifact, type BrowserState } from "@ace/protocol";
import { LiveCapture } from "./live.ts";
import { SessionLogs } from "./logs.ts";
import { browserState } from "./session-state.ts";
import { closeSession } from "./session-close.ts";
import { QueueBudget } from "./session-queue.ts";
import { SessionRecording } from "./session-recording.ts";
import type { NavigationTask } from "./navigation.ts";
import { SessionTabs } from "./session-tabs.ts";
import { TabRuntime, type TabHost } from "./tab-runtime.ts";
import { executeDownloads, executeTabs } from "./session-structure.ts";
import { freezeIdleTabs, wakeTab } from "./session-lifecycle.ts";
import { tabCommand } from "./session-commands.ts";
import { collaborationTiming } from "./collaboration.ts";

import type { Actor, SessionOptions } from "./session-options.ts";
export type { Actor, SessionOptions } from "./session-options.ts";

/**
 * One thread's browser: its tabs, the person's view of them, and the thread-wide facts every tab
 * shares (open, paused, logs, recording). Each tab runs its own commands (TabRuntime); this
 * routes commands to tabs and changes the tab set.
 */
export class BrowserSession {
  readonly live: LiveCapture;
  lastActivity: number;
  private logs: SessionLogs;
  private options: SessionOptions;
  private tabs: SessionTabs;
  private budget = new QueueBudget(128);
  private closed = false;
  private closing: Promise<void> | undefined;
  private recordings: SessionRecording;
  private paused = false;
  private blocked: BrowserOriginBlock | undefined;
  private policies = new NavigationPolicies();
  private lastUrl: string | undefined;
  private reason: string | undefined;
  private pageStateLost = false;
  /** Paused by a detached backend that may still return the same pages. */
  private reattaching = false;
  /** The tab whose frames the live capture carries: the one the person views. */
  private captured: string | undefined;
  private persisted = "";
  private capturing: Promise<void> = Promise.resolve();
  private captureToken = 0;
  private stopLifecycle = () => {};
  get evictable(): boolean {
    return (
      this.tabs.all().every((tab) => !tab.private && !tab.busy) &&
      this.options.now() - this.lastActivity >= 30_000 &&
      !this.recordings.active &&
      !this.options.backend.tabs?.dialog()
    );
  }
  /** The tab the person views is one they keep agents out of. */
  get viewedPrivate(): boolean {
    return this.tabs.viewed()?.private ?? false;
  }
  get navigationTask(): NavigationTask | undefined {
    return this.policies.task;
  }
  initiatingHuman(): boolean {
    return this.policies.task?.human ?? this.personDrives(this.tabs.viewed());
  }
  /**
   * Whether work in a tab with no command behind it (a page's own navigation or popup) is the
   * person's: unless an agent uses the tab and the person has not touched it more recently.
   */
  private personDrives(tab: TabRuntime | undefined): boolean {
    if (!tab?.inUse()) return true;
    return tab.humanWithin(this.timing.quietMs);
  }
  private get timing() {
    return this.options.collaboration ?? collaborationTiming;
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
  constructor(options: SessionOptions) {
    this.options = options;
    this.lastActivity = options.now();
    this.logs = new SessionLogs(options.dir);
    this.recordings = new SessionRecording(options, () => this.paused);
    this.tabs = new SessionTabs(this.host(), () => this.options.backend);
    for (const record of options.restoredTabs ?? [])
      this.tabs.expect(record.tabId, {
        openedBy: record.openedBy,
        label: record.label,
        lastActiveAt: record.lastActiveAt,
        private: record.private,
      });
    this.tabs.reconcile();
    this.captured = this.tabs.viewedId();
    this.live = new LiveCapture(
      this.viewedPage().cdp,
      options.now,
      (frame, epoch) => {
        const viewed = this.tabs.viewed();
        if (viewed && !viewed.private && epoch === viewed.access.epoch)
          this.recordings.accept(frame);
      },
      () => {
        const access = this.tabs.viewed()?.access;
        return { epoch: access?.epoch ?? 0, since: access?.since ?? -Infinity };
      },
      () => this.viewedPage().viewport(),
      () => (this.options.backend.tabs ? this.captured : undefined),
    );
    this.persist();
    this.scheduleLifecycle();
  }
  private viewedPage() {
    return this.tabs.page(this.tabs.viewedId());
  }
  /** What each tab reaches through its thread. */
  private host(): TabHost {
    return {
      options: this.options,
      logs: this.logs,
      policies: this.policies,
      budget: this.budget,
      timing: this.timing,
      page: (tabId) => this.tabs.page(tabId),
      flags: () => ({
        closed: this.closed,
        paused: this.paused,
        pageStateLost: this.pageStateLost,
      }),
      dialog: (tabId) =>
        this.options.backend.tabs?.list().find((tab) => tab.tabId === tabId)?.pending_dialog,
      answer: async (dialogId, accept, promptText) => {
        const tabs = this.options.backend.tabs;
        if (!tabs) throw new BrowserActionError("not_supported");
        await tabs.answer(dialogId, accept, promptText);
      },
      blocked: () => this.blocked,
      blockedNavigation: (blocked) => this.blockedNavigation(blocked),
      clearBlocked: () => {
        this.blocked = undefined;
      },
      state: () => this.state,
      emit: () => this.emit(),
      privacyChanged: () => {
        this.options.backend.privateMode?.(this.tabs.all().some((tab) => tab.private));
        this.persist();
      },
      wake: async (tabId) => {
        const runtime = this.tabs.find(tabId);
        if (runtime && (await wakeTab(runtime))) this.emit();
      },
      beginRecording: (check) => this.recordings.start(check),
      finishRecording: () => this.recordings.stop(),
      annotation: (connectionId: string, event: BrowserAnnotationEvent) =>
        this.options.annotation?.(connectionId, event),
    };
  }
  get state(): BrowserState {
    const viewed = this.tabs.viewed();
    return browserState(this.options, {
      tabs: this.options.backend.tabs ? this.tabs.list() : undefined,
      activeTabId: this.options.backend.tabs ? this.tabs.viewedId() : undefined,
      paused: this.paused,
      closed: this.closed,
      reason: this.reason,
      pageStateLost: this.pageStateLost,
      lastUrl: this.lastUrl,
      blocked: this.blocked,
      annotation: viewed?.annotation.owner,
    });
  }
  private emit(): void {
    this.options.state(this.state);
  }
  private persist(): void {
    if (!this.options.persistTabs || this.closed) return;
    const records = this.tabs.records();
    // Activity times alone do not warrant a write.
    const signature = JSON.stringify(
      records.map((tab) => [tab.tabId, tab.url, tab.title, tab.label, tab.openedBy, tab.private]),
    );
    if (signature === this.persisted) return;
    this.persisted = signature;
    this.options.persistTabs(records);
  }
  navigation(tabId?: string): void {
    this.blocked = undefined;
    (tabId === undefined ? this.tabs.viewed() : this.tabs.find(tabId))?.invalidate();
    this.emit();
  }
  log(entry: BackendLog): void {
    const tab = entry.tabId === undefined ? undefined : this.tabs.find(entry.tabId);
    if (tab ? tab.private : this.tabs.all().some((candidate) => candidate.private)) return;
    this.logs.append(entry.kind, { ...entry, at: this.options.now() });
  }
  /** The backend lost the pages: pause, and report their state gone. */
  suspend(reason: string): void {
    if (this.closed || this.paused) return;
    this.pause(reason);
    this.pageStateLost = true;
    this.emit();
  }
  /**
   * The backend dropped but may hand the same pages back (a desktop re-adopting its views,
   * ADR 0085). Paused like a loss, without claiming the pages are gone: `pagesLost` says so if
   * they do not come back, and `readopt` resumes on them if they do.
   */
  detach(reason: string): void {
    if (this.closed || this.paused) return;
    this.pause(reason);
    this.reattaching = true;
    this.emit();
  }
  /** A detached backend did not come back in time: its pages count as lost. */
  pagesLost(): void {
    if (!this.reattaching || this.closed) return;
    this.reattaching = false;
    this.pageStateLost = true;
    this.emit();
  }
  private pause(reason: string): void {
    for (const tab of this.tabs.all()) tab.lost();
    this.lastUrl = this.options.backend.url();
    this.paused = true;
    this.reason = reason.slice(0, 2048);
    this.live.detach();
  }
  recoveryFailed(reason: string): void {
    this.reason = `The page could not reopen: ${reason}`.slice(0, 2048);
    this.paused = true;
    this.emit();
  }
  async releaseLostBackend(): Promise<void> {
    await Promise.all(this.tabs.all().map((tab) => tab.settled()));
    await this.options.backend.close();
  }
  /** A renderer (`tabId`) or the whole browser came back: re-arm annotate mode and capture. */
  restarted(tabId?: string): void {
    const tabs = tabId === undefined ? this.tabs.all() : [this.tabs.find(tabId)];
    for (const tab of tabs) tab?.restarted();
    if (tabId !== undefined && tabId !== this.captured) return;
    this.recapture("The page could not reconnect");
  }
  /**
   * Point the live capture at the viewed tab. Changes run one at a time and a newer one
   * supersedes a pending one, so quick view changes never fail each other.
   */
  private recapture(failure: string): void {
    const token = ++this.captureToken;
    let target: string | undefined;
    this.capturing = this.capturing
      .then(async () => {
        if (token !== this.captureToken || this.closed || this.paused) return;
        target = this.tabs.viewedId();
        await this.live.replace(this.viewedPage().cdp);
        if (token === this.captureToken) this.emit();
      })
      .catch((error: unknown) => {
        // A shown tab closing under its capture is not a lost browser: the next shown tab
        // takes the capture once the backend reports it (`changed`).
        if (target !== undefined && this.tabs.leaving(target)) return;
        if (token === this.captureToken && !this.closed)
          this.suspend(error instanceof Error ? error.message : failure);
      });
  }
  /** The thread's pages were reopened on a new backend session; their state is gone. */
  async replace(
    backend: BrowserBackendSession,
    kind: "embedded" | "headless" = "headless",
    signal?: AbortSignal,
  ): Promise<void> {
    await this.swap(backend, kind, signal);
    this.pageStateLost = true;
    this.reason = "The page was reopened after the browser disconnected";
    this.emit();
  }
  /**
   * The detached backend handed the same pages back (a desktop re-adoption): documents, scroll
   * and form state survived, so nothing is reported lost.
   */
  async readopt(backend: BrowserBackendSession, signal?: AbortSignal): Promise<void> {
    await this.swap(backend, "embedded", signal);
    this.pageStateLost = false;
    this.reason = undefined;
    this.emit();
  }
  private async swap(
    backend: BrowserBackendSession,
    kind: "embedded" | "headless",
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    await Promise.all(this.tabs.all().map((tab) => tab.settled()));
    signal?.throwIfAborted();
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    for (const tab of this.tabs.all()) tab.annotation.end("restart");
    await this.options.backend.close().catch(() => {});
    signal?.throwIfAborted();
    // A private page the person was viewing stays private on its replacement.
    const carried = { private: this.tabs.viewed()?.private ?? false };
    this.options.backend = backend;
    this.options.backendKind = kind;
    backend.privateMode?.(carried.private);
    const { removed } = this.tabs.reconcile(carried);
    for (const tab of removed) void tab.close();
    for (const tab of this.tabs.all()) tab.rebind();
    backend.privateMode?.(this.tabs.all().some((tab) => tab.private));
    this.captured = this.tabs.viewedId();
    // Supersede any view change queued against the old backend.
    this.captureToken++;
    await this.live.replace(this.viewedPage().cdp);
    signal?.throwIfAborted();
    this.lastUrl = undefined;
    this.paused = false;
    this.reattaching = false;
  }
  /** The tab an input or privacy change names; omitted, the tab the person views. */
  private tab(tabId?: string): TabRuntime {
    if (this.closed) throw new BrowserActionError("browser_closed");
    return tabId === undefined
      ? this.tabs.resolve({ kind: "human", connectionId: "" })
      : this.tabs.get(tabId);
  }
  /** "Keep agents out of this tab", or let them back in. */
  setPrivate(tabId: string, value: boolean): BrowserState {
    if (this.tab(tabId).setPrivate(value)) this.emit();
    return this.state;
  }
  /** The person used a tab in a view the daemon does not route (the desktop's native view). */
  leaveUnasked(tabId?: string): boolean {
    if (this.closed) return false;
    return (
      (tabId === undefined ? this.tabs.viewed() : this.tabs.find(tabId))?.leaveUnasked() ?? false
    );
  }
  humanActivity(tabId?: string): void {
    if (this.closed) return;
    (tabId === undefined ? this.tabs.viewed() : this.tabs.find(tabId))?.humanActivity();
  }
  disconnect(connectionId: string): void {
    for (const tab of this.tabs.all())
      if (tab.annotation.owner === connectionId) tab.annotation.end("disconnect");
  }
  /** The backend's tabs, dialogs or view changed. */
  changed(): void {
    for (const tab of this.tabs.all()) tab.changed();
    if (this.closed) return;
    const viewed = this.tabs.viewed();
    const { added, removed } = this.tabs.reconcile();
    for (const tab of removed) void tab.close();
    // A popup of a private page is private too.
    for (const tab of added)
      if (tab.openedBy?.kind === "page" && viewed?.private) tab.setPrivate(true);
    const viewedId = this.tabs.viewedId();
    if (viewedId !== this.captured && !this.paused) {
      this.tabs.find(this.captured ?? "")?.annotation.end("tab");
      this.captured = viewedId;
      this.recapture("Tab capture failed");
      // A backend that treats only the shown view specially (the desktop) relearns it.
      const shown = this.tabs.viewed();
      if (shown)
        void this.options.backend.agentUse?.(shown.id, shown.inUse() !== undefined).catch(() => {});
    }
    this.persist();
    this.emit();
  }
  execute(raw: unknown, actor: Actor = { kind: "agent" }, signal?: AbortSignal): Promise<unknown> {
    return this.submit(BrowserCommand.parse(raw), actor, signal);
  }
  /** Popup events capture the submitting lease and page before entering their tab's queue. */
  async popup(url: string, target: PopupTarget): Promise<void> {
    const runtime =
      (target.tabId === undefined ? undefined : this.tabs.find(target.tabId)) ?? this.tabs.viewed();
    if (!runtime) throw new BrowserActionError("backend_changed");
    const actor: Actor =
      (this.policies.task?.human ?? this.personDrives(runtime))
        ? { kind: "human", connectionId: "" }
        : { kind: "agent" };
    await runtime.submit(tabCommand({ action: "navigate", url }), actor, undefined, target);
  }
  private ready(): void {
    if (this.closed) throw new BrowserActionError("browser_closed");
    if (this.paused) throw new BrowserActionError("browser_paused");
  }
  /**
   * The tab a command runs on. An agent without a tab of its own gets one when the viewed tab is
   * another agent's. Synchronous whenever no tab must open, so a command captures the control
   * generation of the moment it was submitted.
   */
  private route(actor: Actor, tabId?: string): TabRuntime | Promise<TabRuntime> {
    if (tabId !== undefined || !this.tabs.contended(actor)) return this.tabs.resolve(actor, tabId);
    return this.tabs
      .structural(() => this.tabs.open(actor, {}))
      .then(
        (runtime) => {
          this.changed();
          return runtime;
        },
        (error: unknown) => {
          if (error instanceof BrowserActionError && error.code === "tab_limit")
            return this.tabs.resolve(actor);
          throw error;
        },
      );
  }
  private onTab<T>(
    actor: Actor,
    tabId: string | undefined,
    work: (runtime: TabRuntime) => Promise<T>,
  ): Promise<T> {
    try {
      const runtime = this.route(actor, tabId);
      return runtime instanceof TabRuntime ? work(runtime) : runtime.then(work);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private structure() {
    return {
      tabs: this.tabs,
      backend: () => this.options.backend,
      ready: () => this.ready(),
      closeBrowser: (actor: Actor, signal?: AbortSignal) => this.closeBy(actor, signal),
      changed: () => this.changed(),
      navigate: (runtime: TabRuntime, url: string, actor: Actor, signal?: AbortSignal) =>
        runtime.submit(tabCommand({ action: "navigate", url }), actor, signal),
    };
  }
  private submit(command: BrowserCommand, actor: Actor, signal?: AbortSignal): Promise<unknown> {
    this.lastActivity = this.options.now();
    if (this.closed) return Promise.reject(new BrowserActionError("browser_closed"));
    switch (command.action) {
      case "tabs":
        return executeTabs(this.structure(), command, actor, signal);
      case "downloads":
        return this.onTab(actor, command.tabId, async (runtime) => {
          runtime.readCheck(actor);
          return executeDownloads(this.structure(), command, this.options.navigationClock, signal);
        });
      case "extensions":
        return (async () => ({ extensions: (await this.options.backend.extensions?.()) ?? [] }))();
      case "dialog": {
        // A dialog answer goes to the tab that raised it, whichever tab the caller names.
        const owner = this.options.backend.tabs
          ?.list()
          .find((tab) => tab.pending_dialog?.dialogId === command.dialogId)?.tabId;
        return this.onTab(actor, owner ?? command.tabId, (runtime) =>
          runtime.submit(command, actor, signal),
        );
      }
      default:
        return this.onTab(actor, command.tabId, (runtime) =>
          runtime.submit(command, actor, signal),
        );
    }
  }
  screenshot(
    signal?: AbortSignal,
    tabId?: string,
    options: { fullPage?: boolean | undefined; ref?: string | undefined } = {},
    actor: Actor = { kind: "agent" },
  ): Promise<Uint8Array> {
    this.lastActivity = this.options.now();
    return this.onTab(actor, tabId, (runtime) => runtime.screenshot(actor, signal, options));
  }
  closeBy(actor: Actor, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // An agent never closes a browser holding a private tab or one the person is busy in.
    if (actor.kind === "agent")
      for (const tab of this.tabs.all()) {
        tab.readCheck(actor);
        if (tab.humanWithin(this.timing.quietMs)) throw new BrowserActionError("human_active");
      }
    this.options.forgetTabs?.();
    return this.close();
  }
  input(raw: unknown, connectionId: string, tabId?: string): Promise<void> {
    return this.tab(tabId).input(raw, connectionId);
  }
  startRecording(): Promise<void> {
    const viewed = this.tab();
    const epoch = viewed.access.epoch;
    return viewed.serialize(() =>
      this.recordings.start(() => viewed.readCheck({ kind: "agent" }, epoch)),
    );
  }
  stopRecording(actor: Actor = { kind: "agent" }): Promise<BrowserArtifact> {
    const viewed = this.tab();
    const epoch = viewed.access.epoch;
    return viewed.serialize(() => {
      viewed.readCheck(actor, epoch);
      return this.recordings.stop();
    });
  }
  private scheduleLifecycle(): void {
    const lifecycle = this.options.lifecycle;
    if (!lifecycle || this.closed) return;
    this.stopLifecycle = lifecycle.set(lifecycle.every, () => {
      if (this.closed) return;
      const dialogs = new Set(
        this.options.backend.tabs?.list().flatMap((tab) => (tab.pending_dialog ? [tab.tabId] : [])),
      );
      void freezeIdleTabs(
        this.tabs.all(),
        this.tabs.viewedId(),
        this.options.now(),
        lifecycle.policy,
        (tab) => dialogs.has(tab.id) || this.recordings.active,
      )
        .then((changed) => {
          if (changed) this.emit();
        })
        .finally(() => this.scheduleLifecycle());
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopLifecycle();
      for (const tab of this.tabs.all()) tab.annotation.end("stopped");
      this.lastUrl = this.options.backend.url();
      this.closed = true;
      this.options.cancelPolicy();
      this.emit();
      await closeSession(
        this.options,
        this.live,
        () => Promise.all(this.tabs.all().map((tab) => tab.settled())),
        this.recordings,
        this.logs,
      );
    })();
    return this.closing;
  }
  /**
   * The agent's own tab, claiming one as a command would (a new tab when the viewed one is
   * another agent's). Refuses a tab a person holds privately.
   */
  async claim(actor: Actor): Promise<{ tabId: string; url: string; title: string }> {
    if (this.closed) throw new BrowserActionError("browser_closed");
    await this.onTab(actor, undefined, async (runtime) => runtime.readCheck(actor));
    return this.currentTab(actor);
  }
  /** The tab an agent's next command without `tabId` would use, with its address. */
  currentTab(actor: Actor): { tabId: string; url: string; title: string } {
    const tabId = this.tabs.resolve(actor).id;
    const tab = this.tabs.list(actor).find((entry) => entry.tabId === tabId);
    return { tabId, url: tab?.url ?? this.options.backend.url(), title: tab?.title ?? "" };
  }
}
