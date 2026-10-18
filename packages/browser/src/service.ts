import { randomUUID } from "node:crypto";

import {
  BrowserOpen,
  browserSessionLimit,
  type BrowserArtifact,
  type BrowserState,
  type BrowserFrame,
} from "@ace/protocol";
import { recoverHeadless } from "./recovery.ts";
import { DesktopLoss } from "./desktop-loss.ts";
import { detectFfmpeg } from "./discovery.ts";
import { ownedHeadless } from "./owned-backend.ts";
import { BrowserProfiles } from "./profiles.ts";
import { TabBudget } from "./tab-budget.ts";
import { daemonTabLimit, threadTabLimit } from "./tab-limits.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";
import type { LifecycleSchedule } from "./session-lifecycle.ts";
import { EmbeddedBackend, type EmbeddedTransport } from "./embedded.ts";
import type { BrowserBackend, BackendOpen, BrowserBackendSession } from "./backend.ts";
import type {
  BrowserAnnotationMessage,
  BrowserBackendLost,
  BrowserDownloadProgress,
} from "@ace/protocol";
import { sessionPolicies } from "./session-policies.ts";
import { agentResumes, backendCandidates } from "./backend-choice.ts";
import { BrowserSession, type Actor } from "./session.ts";
import type { FrameSink } from "./fanout.ts";
import { BrowserSubscriptions } from "./subscriptions.ts";

import { PolicyGate } from "./policy-call.ts";
import { setMaxListeners } from "node:events";
import type { BrowserServiceOptions } from "./service-options.ts";
import type { PersonRequest } from "./person-requests.ts";
export type { BrowserServiceOptions } from "./service-options.ts";

export class BrowserService {
  private options: BrowserServiceOptions;
  private tabs: TabBudget;
  private sessions = new Map<string, BrowserSession>();
  private generations = new WeakMap<BrowserSession, number>();
  private sequence = 0;
  private opening = new Map<string, Promise<BrowserSession>>();
  private profiles: BrowserProfiles;
  private subscriptions: BrowserSubscriptions;
  private frameMessages = new WeakMap<BrowserFrame, string>();
  private now: () => number;
  private id: () => string;
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  private policyGate = new PolicyGate();
  private embedded: EmbeddedBackend | undefined;
  private headless: BrowserBackend;
  private acquisition: ReturnType<typeof ownedHeadless>;
  private recoveries = new Map<string, Promise<void>>();
  /** Sessions paused by desktop loss, with a single-flight recovery on the available backend. */
  private resumable = new Map<string, () => Promise<void>>();
  get hasActiveSessions(): boolean {
    return this.sessions.size > 0 || this.opening.size > 0 || this.recoveries.size > 0;
  }
  hasActiveSession(threadId: string): boolean {
    return (
      this.sessions.has(threadId) || this.opening.has(threadId) || this.recoveries.has(threadId)
    );
  }
  downloadProgress(listener: (progress: BrowserDownloadProgress) => void): () => void {
    return this.acquisition.subscribe(listener);
  }
  private policyScopes = new Map<string, AbortController>();
  private navigationClock: import("./navigation.ts").NavigationClock;
  constructor(options: BrowserServiceOptions) {
    this.options = options;
    this.profiles = new BrowserProfiles(options.dataDir);
    this.subscriptions = new BrowserSubscriptions(
      64 * (options.maxSessions ?? browserSessionLimit),
      (error) => options.onError?.(error),
    );
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.navigationClock = options.navigationClock ?? {
      now: () => performance.now(),
      set: (delay, work) => {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    };
    this.tabs = new TabBudget(options.maxTabs ?? daemonTabLimit);
    this.acquisition = ownedHeadless(options, this.lifetime.signal);
    this.headless = this.acquisition.backend;
  }
  async open(raw: unknown): Promise<BrowserState> {
    if (this.closing) throw new Error("Browser service shutting down");
    const options = BrowserOpen.parse(raw);
    const existing = this.sessions.get(options.threadId);
    if (existing && !existing.state.closed) {
      // Every client and the agent share the thread's one page, on whichever backend it runs.
      if (!options.background || agentResumes(existing.state, existing.viewedPrivate)) {
        // A replacement can be lost immediately after publishing ready, while its
        // installation promise is still unwinding. Retry after that work settles.
        await this.recoveries.get(options.threadId);
        const retry = this.resumable.get(options.threadId);
        if (!options.background || agentResumes(existing.state, existing.viewedPrivate)) {
          // Another opener may have consumed the callback during our await.
          // Join its installed recovery promise instead of returning paused.
          await (retry ? retry() : this.recoveries.get(options.threadId));
        }
      }
      return existing.state;
    }
    if (existing) await existing.close();
    const pending = this.opening.get(options.threadId);
    if (pending) return (await pending).state;
    if (
      this.sessions.size + this.opening.size >=
      (this.options.maxSessions ?? browserSessionLimit)
    ) {
      const idle = [...this.sessions.values()]
        .filter((session) => session.evictable)
        .toSorted((a, b) => a.lastActivity - b.lastActivity)[0];
      if (idle) await idle.close();
      if (
        this.sessions.size + this.opening.size >=
        (this.options.maxSessions ?? browserSessionLimit)
      )
        throw new Error("All browser pages are in use. Close an idle thread's page and try again.");
    }
    const scope = new AbortController();
    this.policyScopes.set(options.threadId, scope);
    const task = this.launch(options, scope);
    this.opening.set(options.threadId, task);
    try {
      return (await task).state;
    } finally {
      this.opening.delete(options.threadId);
      if (!this.sessions.has(options.threadId)) this.policyScopes.delete(options.threadId);
    }
  }
  private async launch(requested: BrowserOpen, scope: AbortController): Promise<BrowserSession> {
    const signal = AbortSignal.any([scope.signal, this.lifetime.signal]);
    setMaxListeners(1057, signal);
    const options: BrowserOpen = {
      ...requested,
      profile:
        requested.profile ?? (await this.options.profilePreference?.(requested)) ?? "persistent",
    };
    const preference = (await this.options.backendPreference?.(options)) ?? "auto";
    const lossPolicy = (await this.options.backendLoss?.(options)) ?? "pause";
    const embedded = this.embedded;
    const candidates = backendCandidates(preference, embedded !== undefined).map((kind) =>
      kind === "embedded" && embedded ? embedded : this.headless,
    );
    let backend = candidates[0] ?? this.headless;
    signal.throwIfAborted();
    const profileLease = await this.profiles.acquire();
    const { profile, dir, downloadDir } = profileLease;
    const store = this.options.tabStore;
    const restoredTabs = this.restoredTabs(options.threadId);
    let context: BrowserBackendSession | undefined;
    let recoveryGeneration = 0;
    let session: BrowserSession | undefined;
    let released = false;
    let backendLost = false;
    const loss = new DesktopLoss(this.navigationClock, this.options.desktopReadoptionGraceMs);
    let opening: BackendOpen | undefined;
    const release = async () => {
      if (released) return;
      released = true;
      loss.finish();
      if (session && this.sessions.get(options.threadId) === session)
        this.sessions.delete(options.threadId);
      scope.abort();
      if (this.policyScopes.get(options.threadId) === scope)
        this.policyScopes.delete(options.threadId);
      if (this.resumable.get(options.threadId) === resume) this.resumable.delete(options.threadId);
    };
    /** Tells viewers the thread's pages are gone and why. */
    const announce = (url: string, reason: string) => {
      if (!session) return;
      session.pagesLost();
      const event: BrowserBackendLost = {
        type: "browser.backend.lost",
        threadId: options.threadId,
        backend: "embedded",
        recovery: lossPolicy,
        url,
        pageStateLost: true,
        reason: reason.slice(0, 2048),
      };
      try {
        this.options.onBackendLost?.(event);
      } catch (error) {
        this.options.onError?.(error);
      }
      this.subscriptions.backendLost(event);
    };
    /** Reopen the last URL; use the same desktop profile whenever the desktop is available. */
    const resume = (): Promise<void> => {
      const owned = session;
      const running = this.recoveries.get(options.threadId);
      if (running) return running;
      if (!owned || !opening) return Promise.resolve();
      // While the desktop may still hand its views back, only the desktop takes the page.
      if (!this.embedded && loss.pending) return loss.settled().then(() => resume());
      const recoveryRequest = opening;
      this.resumable.delete(options.threadId);
      const native = this.embedded;
      const recover = async () => {
        await owned.releaseLostBackend();
        const generation = ++recoveryGeneration;
        if (!native) {
          await recoverHeadless({
            request: recoveryRequest,
            backend: this.headless,
            session: owned,
            url: owned.state.url,
            lost: (reason) => {
              if (signal.aborted || owned.state.closed || recoveryGeneration !== generation) return;
              owned.suspend(reason);
              this.resumable.set(options.threadId, resume);
            },
          });
          loss.finish();
          return;
        }
        const url = owned.state.url;
        const replacement = await native.open(recoveryRequest);
        try {
          if (replacement.adopted) await owned.readopt(replacement);
          else {
            replacement.privateMode?.(owned.viewedPrivate);
            if (url !== "about:blank") await replacement.navigate(url, 10_000);
            await owned.replace(replacement, "embedded");
            // A fresh view: the pages are gone, whether or not the grace had said so yet.
            if (!loss.reported) announce(url, "The desktop opened a new page");
          }
          loss.finish();
          backend = native;
          backendLost = false;
        } catch (error) {
          await replacement.close().catch(() => {});
          throw error;
        }
      };
      const recovery = recover()
        .catch((error) => {
          this.resumable.set(options.threadId, resume);
          if (!signal.aborted)
            owned.recoveryFailed(
              error instanceof Error ? error.message : "Browser recovery failed",
            );
          this.options.onError?.(error);
        })
        .finally(() => this.recoveries.delete(options.threadId));
      this.recoveries.set(options.threadId, recovery);
      return recovery;
    };
    try {
      const policies = sessionPolicies(
        options,
        this.options,
        signal,
        this.policyGate,
        () => session,
      );
      const request: BackendOpen = {
        id: this.id,
        reserveTab: () => this.tabs.reserve(),
        maxTabs: threadTabLimit,
        ...(restoredTabs.length
          ? { restoreTabs: restoredTabs.map(({ tabId, url }) => ({ tabId, url })) }
          : {}),
        changed: () => session?.changed(),
        downloadDir,
        ...(this.options.maxDownloadBytes
          ? { maxDownloadBytes: this.options.maxDownloadBytes }
          : {}),
        downloadAllowed: policies.downloadAllowed,
        artifact: (artifact) => this.options.onArtifact?.(options.threadId, artifact),
        options,
        profileDir: profile,
        signal,
        allowed: policies.allowed,
        popup: (url, target) =>
          session
            ? session.popup(url, target)
            : Promise.reject(new Error("Browser session not ready")),
        initiator: () => session?.initiatingHuman() ?? false,
        humanInput: (tabId) => session?.humanActivity(tabId),
        navigation: (tabId) => session?.navigation(tabId),
        restarted: (tabId) => session?.restarted(tabId),
        log: (entry) => session?.log(entry),
        permissionDenied: (denial) =>
          session?.log({
            kind: "console",
            type: "permission.denied",
            text: `${denial.permission} ${denial.origin}`,
          }),
        downloadDenied: (denial) =>
          session?.log({
            kind: "network",
            type: "download.denied",
            text: `${denial.url} ${denial.suggestedFilename}`,
          }),
        lost: (reason) => {
          if (!session || session.state.closed || signal.aborted) return;
          // Only the desktop's views come back: ace's Chrome restarts its own pages, and the
          // person's own browser must never be swapped for another (its logins would not follow).
          if (backend.kind !== "embedded") {
            void session.close().catch((error) => this.options.onError?.(error));
            return;
          }
          if (backendLost) return;
          backendLost = true;
          const owned = session;
          const url = owned.state.url;
          this.resumable.set(options.threadId, resume);
          const lose = () => {
            if (owned.state.closed || signal.aborted) return;
            announce(url, reason);
            if (lossPolicy === "headless") void resume();
          };
          // A dropped link (the backend unregistered) keeps the desktop's views for re-adoption;
          // a view that died with the link up is gone now.
          if (this.embedded === backend) {
            owned.suspend(reason);
            loss.reported = true;
            lose();
            return;
          }
          owned.detach(reason);
          loss.begin(lose);
        },
      };
      opening = request;
      for (const [index, candidate] of candidates.entries()) {
        backend = candidate;
        try {
          context = await candidate.open(request);
          break;
        } catch (error) {
          // The desktop could not host the view: auto continues with ace's own Chromium.
          if (signal.aborted || index === candidates.length - 1) throw error;
          this.options.onError?.(error);
        }
      }
      if (!context) throw new Error("No browser backend opened");
      signal.throwIfAborted();
      const ffmpeg = this.options.ffmpeg ?? (await detectFfmpeg());
      session = new BrowserSession({
        threadId: options.threadId,
        backend: context,
        backendKind: backend.kind,
        dir,
        now: this.now,
        id: this.id,
        navigationClock: this.navigationClock,
        cancelPolicy: () => scope.abort(),
        ...(this.options.collaboration ? { collaboration: this.options.collaboration } : {}),
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(ffmpeg ? { ffmpeg } : {}),
        ...policies.session,
        artifact: (artifact) => this.options.onArtifact?.(options.threadId, artifact),
        state: (state) => this.emit(state),
        annotation: (connectionId, event) =>
          this.subscriptions.annotation(connectionId, {
            type: "browser.annotation",
            threadId: options.threadId,
            event,
          }),
        cleanup: async () => {
          await release();
        },
        ...(restoredTabs.length ? { restoredTabs } : {}),
        ...(store
          ? {
              persistTabs: (records) => {
                try {
                  store.save(options.threadId, records);
                } catch (error) {
                  this.options.onError?.(error);
                }
              },
              forgetTabs: () => {
                try {
                  store.clear(options.threadId);
                } catch (error) {
                  this.options.onError?.(error);
                }
              },
            }
          : {}),
        ...(backend.kind === "headless" ? this.lifecycle() : {}),
      });
      await session.live.start();
      this.sessions.set(options.threadId, session);
      this.generations.set(session, ++this.sequence);
      this.subscriptions.replace(options.threadId, session.live.fanout);
      this.emit(session.state);
      return session;
    } catch (error) {
      await session?.close().catch(() => {});
      await context?.close().catch(() => {});
      await release();
      await profileLease.discard();
      throw error;
    }
  }
  /** The thread's tabs from before a daemon restart; an unreadable store restores none. */
  private restoredTabs(threadId: string) {
    try {
      return (this.options.tabStore?.load(threadId) ?? []).toSorted(
        (a, b) => a.position - b.position,
      );
    } catch (error) {
      this.options.onError?.(error);
      return [];
    }
  }
  /** Idle tabs in ace's Chrome freeze; the desktop's views manage themselves. */
  private lifecycle(): { lifecycle?: LifecycleSchedule } {
    const configured = this.options.tabLifecycle;
    if (configured === false) return {};
    return {
      lifecycle: configured ?? {
        policy: defaultTabLifecycle,
        every: 60_000,
        set: (delay, work) => {
          const timer = setTimeout(work, delay);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
    };
  }
  registerEmbedded(transport: EmbeddedTransport): EmbeddedBackend {
    if (this.closing) throw new Error("Browser service shutting down");
    if (this.embedded) throw new Error("Desktop browser backend already registered");
    const backend = new EmbeddedBackend(
      this.id(),
      transport,
      () => {
        if (this.embedded === backend) this.embedded = undefined;
      },
      this.navigationClock,
    );
    this.embedded = backend;
    // After this returns the caller sends the registration reply; requests follow it.
    queueMicrotask(() => {
      this.options.onEmbeddedRegistered?.();
      for (const resume of this.resumable.values()) void resume();
    });
    return backend;
  }
  /**
   * The thread was deleted: close its browser and, when a desktop is registered, drop its native
   * partition. ace's own browser profile is shared by every thread and stays (ADR 0083).
   * `desktop` says whether the desktop purged.
   */
  async forgetThread(threadId: string, workspaceId: string): Promise<{ desktop: boolean }> {
    await this.closeThread(threadId);
    this.options.tabStore?.clear(threadId);
    const embedded = this.embedded;
    if (!embedded) return { desktop: false };
    await embedded.purge(threadId, workspaceId);
    return { desktop: true };
  }
  private get(threadId: string): BrowserSession {
    const session = this.sessions.get(threadId);
    if (!session || session.state.closed) throw new Error("Browser session not open");
    return session;
  }
  downloadsList(threadId: string) {
    return this.get(threadId).state.downloads ?? [];
  }
  generation(threadId: string): number {
    const generation = this.generations.get(this.get(threadId));
    if (generation === undefined) throw new Error("Browser generation unavailable");
    return generation;
  }
  replayFrame(threadId: string, connectionId: string): void {
    this.get(threadId).live.fanout.replay(connectionId);
  }
  state(threadId: string): BrowserState {
    return this.get(threadId).state;
  }
  execute(
    threadId: string,
    command: unknown,
    actor?: Actor,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(threadId).execute(command, actor, signal);
  }
  /**
   * Bound JPEG bytes from one tab's page, without interpreting an artifact path. The tab the
   * person views does not change.
   */
  screenshot(
    threadId: string,
    signal?: AbortSignal,
    tabId?: string,
    options: { fullPage?: boolean | undefined; ref?: string | undefined } = {},
    actor?: Actor,
  ): Promise<Uint8Array> {
    return this.get(threadId).screenshot(signal, tabId, options, actor);
  }
  /** The agent's own tab, opening one if the viewed tab is another agent's. */
  claimTab(threadId: string, actor: Actor): Promise<{ tabId: string; url: string; title: string }> {
    return this.get(threadId).claim(actor);
  }
  /** The tab an agent's next command without `tabId` runs on. */
  currentTab(threadId: string, actor: Actor): { tabId: string; url: string; title: string } {
    return this.get(threadId).currentTab(actor);
  }
  input(threadId: string, input: unknown, connectionId: string, tabId?: string): Promise<void> {
    return this.get(threadId).input(input, connectionId, tabId);
  }
  /** "Keep agents out of this tab" (a person's choice), or let them back in. */
  setPrivate(threadId: string, tabId: string, value: boolean): BrowserState {
    return this.get(threadId).setPrivate(tabId, value);
  }
  /** What only the person may ask of a page, from their own client connection. */
  asPerson(threadId: string, request: PersonRequest): Promise<BrowserState> {
    return this.get(threadId).asPerson(request);
  }
  disconnect(connectionId: string): void {
    for (const session of this.sessions.values()) session.disconnect(connectionId);
  }
  subscribe(
    threadId: string,
    connectionId: string,
    sink: FrameSink,
    onState: (state: BrowserState) => void,
    onBackendEvent?: (event: BrowserBackendLost | BrowserAnnotationMessage) => void,
  ): () => void {
    const session = this.get(threadId);
    return this.subscriptions.add(threadId, session.live.fanout, session.state, {
      connectionId,
      sink,
      state: onState,
      ...(onBackendEvent ? { event: onBackendEvent } : {}),
    });
  }
  configureCapture(
    threadId: string,
    connectionId: string,
    capture: import("./fanout.ts").CaptureViewer,
  ): void {
    this.subscriptions.configure(threadId, connectionId, capture);
    this.get(threadId).live.fanout.configure(connectionId, capture);
  }
  acknowledge(threadId: string, connectionId: string, sequence: number): void {
    this.get(threadId).live.fanout.acknowledge(connectionId, sequence);
  }
  /** Share one serialization across every viewer of this exact frame. */
  serializeFrame(threadId: string, frame: BrowserFrame): string {
    let message = this.frameMessages.get(frame);
    if (!message) {
      message = JSON.stringify({ type: "browser.frame", threadId, frame });
      this.frameMessages.set(frame, message);
    }
    return message;
  }
  private emit(state: BrowserState): void {
    this.subscriptions.state(state);
  }
  startRecording(threadId: string): Promise<void> {
    return this.get(threadId).startRecording();
  }
  stopRecording(threadId: string, actor?: Actor): Promise<BrowserArtifact> {
    return this.get(threadId).stopRecording(actor);
  }
  async closeThread(threadId: string, actor?: Actor, signal?: AbortSignal): Promise<void> {
    // Agent closure must not revoke policies or start recovery cleanup before ownership is checked.
    const current = this.sessions.get(threadId);
    if (actor && current) {
      await current.closeBy(actor, signal);
      this.sessions.delete(threadId);
      this.options.tabStore?.clear(threadId);
      return;
    }
    signal?.throwIfAborted();
    this.policyScopes.get(threadId)?.abort();
    await this.recoveries.get(threadId);
    const session = this.sessions.get(threadId) ?? (await this.opening.get(threadId));
    if (session) {
      await session.closeBy(actor ?? { kind: "human", connectionId: "" }, signal);
      this.sessions.delete(threadId);
    }
    // A closed browser starts fresh next time; a daemon restart is not a close.
    this.options.tabStore?.clear(threadId);
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      this.embedded?.disconnect("Browser service shutting down");
      await Promise.allSettled(this.recoveries.values());
      await Promise.allSettled(this.opening.values());
      await this.acquisition.settled();
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => session.close()),
      );
      this.sessions.clear();
      this.policyScopes.clear();
      this.subscriptions.clear();
      await this.acquisition.close();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.closing;
  }
}
