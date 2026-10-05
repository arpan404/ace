import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  BrowserOpen,
  type BrowserArtifact,
  type BrowserState,
  type BrowserFrame,
} from "@ace/protocol";
import { recoverHeadless } from "./recovery.ts";
import { detectFfmpeg } from "./discovery.ts";
import { HeadlessBackend } from "./headless.ts";
import { acquireChromium } from "./acquisition.ts";
import { EmbeddedBackend, type EmbeddedTransport } from "./embedded.ts";
import type { BrowserBackend, BackendOpen, BrowserBackendSession } from "./backend.ts";
import type { BrowserBackendLost, BrowserDownloadProgress } from "@ace/protocol";
import { BrowserOriginError, browserOrigin, allowedOrigin } from "./policy.ts";
import { BrowserSession, type Actor } from "./session.ts";
import type { FrameSink } from "./fanout.ts";
import { BrowserSubscriptions } from "./subscriptions.ts";

import { PolicyGate } from "./policy-call.ts";
import { setMaxListeners } from "node:events";
import type { BrowserServiceOptions } from "./service-options.ts";
export type { BrowserServiceOptions } from "./service-options.ts";

export class BrowserService {
  private options: BrowserServiceOptions;
  private tabCount = 0;
  private reserveTab = (): (() => void) => {
    if (this.tabCount >= (this.options.maxTabs ?? 32)) throw new Error("Daemon browser tab limit");
    this.tabCount++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.tabCount--;
      }
    };
  };
  private sessions = new Map<string, BrowserSession>();
  private generations = new WeakMap<BrowserSession, number>();
  private sequence = 0;
  private opening = new Map<string, Promise<BrowserSession>>();
  private leases = new Set<string>();
  private subscriptions: BrowserSubscriptions;
  private frameMessages = new WeakMap<BrowserFrame, string>();
  private now: () => number;
  private id: () => string;
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  private policyGate = new PolicyGate();
  private embedded: EmbeddedBackend | undefined;
  private headless: BrowserBackend;
  private acquiring: Promise<string> | undefined;
  private recoveries = new Map<string, Promise<void>>();
  private downloadListeners = new Set<(progress: BrowserDownloadProgress) => void>();
  downloadProgress(listener: (progress: BrowserDownloadProgress) => void): () => void {
    if (this.downloadListeners.size >= 64) throw new Error("Browser download subscriber limit");
    this.downloadListeners.add(listener);
    return () => {
      this.downloadListeners.delete(listener);
    };
  }
  private policyScopes = new Map<string, AbortController>();
  private navigationClock: import("./navigation.ts").NavigationClock;
  constructor(options: BrowserServiceOptions) {
    this.options = options;
    this.subscriptions = new BrowserSubscriptions(64 * (options.maxSessions ?? 8), (error) =>
      options.onError?.(error),
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
    this.headless =
      options.headlessBackend ??
      new HeadlessBackend(
        () => {
          if (options.executablePath) return Promise.resolve(options.executablePath);
          this.acquiring ??= acquireChromium({
            ...options.acquisition,
            dataDir: options.dataDir,
            signal: this.lifetime.signal,
            progress: (progress) => {
              options.onDownload?.(progress);
              for (const listener of this.downloadListeners) {
                try {
                  listener(progress);
                } catch (error) {
                  options.onError?.(error);
                }
              }
            },
          }).catch((error) => {
            this.acquiring = undefined;
            throw error;
          });
          return this.acquiring;
        },
        options.launchContext,
        options.cleanup,
      );
  }
  async open(raw: unknown): Promise<BrowserState> {
    if (this.closing) throw new Error("Browser service shutting down");
    const options = BrowserOpen.parse(raw);
    const existing = this.sessions.get(options.threadId);
    if (existing && !existing.state.closed) {
      if (!options.background || existing.state.backend !== "embedded") return existing.state;
      await existing.closeBy({ kind: "agent" });
    }
    if (existing) await existing.close();
    const pending = this.opening.get(options.threadId);
    if (pending) return (await pending).state;
    if (this.sessions.size + this.opening.size >= (this.options.maxSessions ?? 8))
      throw new Error("Browser session limit");
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
  private async launch(options: BrowserOpen, scope: AbortController): Promise<BrowserSession> {
    const signal = AbortSignal.any([scope.signal, this.lifetime.signal]);
    setMaxListeners(33, signal);
    const preference = options.background
      ? "headless"
      : ((await this.options.backendPreference?.(options)) ?? "auto");
    const lossPolicy = (await this.options.backendLoss?.(options)) ?? "pause";
    const backend = preference !== "headless" && this.embedded ? this.embedded : this.headless;
    if (preference === "embedded" && backend.kind !== "embedded")
      throw new Error("Desktop browser backend unavailable");
    signal.throwIfAborted();
    const root = join(this.options.dataDir, "browser");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const workspaceKey = createHash("sha256")
      .update(`${options.workspaceId}:${options.threadId}`)
      .digest("hex");
    const persistent = options.profile === "persistent";
    const profile = persistent
      ? join(root, "profiles", workspaceKey)
      : await mkdtemp(join(root, "ephemeral-"));
    if (this.leases.has(profile)) throw new Error("Workspace browser profile is already in use");
    this.leases.add(profile);
    let context: BrowserBackendSession | undefined;
    let recoveryProfile: string | undefined;
    let session: BrowserSession | undefined;
    let released = false;
    let backendLost = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (session && this.sessions.get(options.threadId) === session)
        this.sessions.delete(options.threadId);
      scope.abort();
      this.options.onNavigation?.(options.threadId);
      if (this.policyScopes.get(options.threadId) === scope)
        this.policyScopes.delete(options.threadId);
      this.leases.delete(profile);
      if (!persistent) await rm(profile, { recursive: true, force: true });
      if (recoveryProfile) await rm(recoveryProfile, { recursive: true, force: true });
    };
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const allowed = async (
        url: string,
        originContext: { navigation?: boolean; human?: boolean } = {},
      ) => {
        const task = session?.navigationTask;
        const policySignal = task ? AbortSignal.any([signal, task.signal]) : signal;
        const resume = originContext.navigation ? session?.policyWait(url) : undefined;
        try {
          const result = await allowedOrigin(
            options.threadId,
            url,
            this.options.originPolicy
              ? (originRequest) =>
                  this.policyGate.run(
                    policySignal,
                    () =>
                      this.options.originPolicy?.({ ...originRequest, signal: policySignal }) ??
                      false,
                    this.options.origins ? 65_000 : 10_000,
                  )
              : undefined,
            {
              ...originContext,
              manageLoopback: this.options.origins !== undefined,
              human: originContext.human ?? session?.initiatingHuman() ?? false,
            },
          );
          if (!result && originContext.navigation)
            session?.blockedNavigation(
              {
                origin: browserOrigin(url) ?? url.slice(0, 8192),
                reason: browserOrigin(url) ? "approval_required" : "invalid_origin",
              },
              task,
            );
          return result;
        } catch (error) {
          if (originContext.navigation && error instanceof BrowserOriginError)
            session?.blockedNavigation(error.blocked, task);
          throw error;
        } finally {
          resume?.();
        }
      };
      const dir = await mkdtemp(join(root, "session-"));
      const downloadDir = join(dir, "downloads");
      await mkdir(downloadDir, { mode: 0o700 });
      const request: BackendOpen = {
        id: this.id,
        reserveTab: this.reserveTab,
        changed: () => session?.changed(),
        downloadDir,
        ...(this.options.maxDownloadBytes
          ? { maxDownloadBytes: this.options.maxDownloadBytes }
          : {}),
        downloadAllowed: (url) =>
          this.policyGate.run(
            signal,
            () => this.options.downloadPolicy?.(options.threadId, url, signal) ?? false,
            65_000,
          ),
        artifact: (artifact) => this.options.onArtifact?.(options.threadId, artifact),
        options,
        profileDir: profile,
        signal,
        allowed,
        initiator: () => session?.initiatingHuman() ?? false,
        navigation: () => session?.navigation(),
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
          if (backend.kind === "headless") {
            void session.close().catch((error) => this.options.onError?.(error));
            return;
          }
          if (backendLost) return;
          backendLost = true;
          session.suspend(reason);
          const event: BrowserBackendLost = {
            type: "browser.backend.lost",
            threadId: options.threadId,
            backend: "embedded",
            recovery: lossPolicy,
            url: session.state.url,
            pageStateLost: true,
            reason: reason.slice(0, 2048),
          };
          try {
            this.options.onBackendLost?.(event);
          } catch (error) {
            this.options.onError?.(error);
          }
          this.subscriptions.backendLost(event);
          if (lossPolicy === "headless") {
            const owned = session;
            const recovery = recoverHeadless({
              request,
              backend: this.headless,
              session: owned,
              root,
              url: event.url,
              profileCreated: (path) => {
                recoveryProfile = path;
              },
            })
              .catch((error) => {
                if (!signal.aborted)
                  owned.recoveryFailed(
                    error instanceof Error ? error.message : "Browser recovery failed",
                  );
                this.options.onError?.(error);
              })
              .finally(() => this.recoveries.delete(options.threadId));
            this.recoveries.set(options.threadId, recovery);
          }
        },
      };
      context = await backend.open(request);
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
        navigatePolicy: (url, actor, commandSignal) => {
          this.options.onNavigation?.(options.threadId);
          const navigationSignal = commandSignal
            ? AbortSignal.any([signal, commandSignal])
            : signal;
          return allowedOrigin(
            options.threadId,
            url,
            this.options.originPolicy
              ? (originRequest) =>
                  this.policyGate.run(
                    navigationSignal,
                    () => this.options.originPolicy?.(originRequest) ?? false,
                    this.options.origins ? 65_000 : 10_000,
                  )
              : undefined,
            {
              manageLoopback: this.options.origins !== undefined,
              human: actor.kind === "human",
              navigation: true,
              signal: navigationSignal,
            },
          );
        },
        cancelPolicy: () => scope.abort(),
        privatePaused: () => this.options.onPrivatePaused?.(options.threadId),
        privateResumed: () => this.options.onPrivateResumed?.(options.threadId),
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(ffmpeg ? { ffmpeg } : {}),
        ...(this.options.evaluatePolicy
          ? {
              evaluatePolicy: (
                threadId: string,
                url: string,
                mode?: "read-only" | "unrestricted",
                expression?: string,
              ) =>
                this.policyGate.run(
                  signal,
                  () =>
                    this.options.evaluatePolicy?.(threadId, url, signal, mode, expression) ?? false,
                  65_000,
                ),
            }
          : {}),
        ...(this.options.artifactAllowed
          ? {
              artifactAllowed: (path: string) =>
                this.options.artifactAllowed?.(options.threadId, path) ?? false,
            }
          : {}),
        ...(this.options.workspaceRoot
          ? { workspaceRoot: () => this.options.workspaceRoot?.(options.threadId) ?? "" }
          : {}),
        ...(this.options.uploadPolicy
          ? {
              uploadPolicy: (paths: string[], commandSignal?: AbortSignal) =>
                this.policyGate.run(
                  commandSignal ? AbortSignal.any([signal, commandSignal]) : signal,
                  () =>
                    this.options.uploadPolicy?.(options.threadId, paths, commandSignal ?? signal) ??
                    false,
                  65_000,
                ),
            }
          : {}),
        artifact: (artifact) => this.options.onArtifact?.(options.threadId, artifact),
        state: (state) => this.emit(state),
        cleanup: async () => {
          await release();
        },
      });
      if (this.options.isPrivatePaused?.(options.threadId)) session.restorePrivate();
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
      throw error;
    }
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
    return backend;
  }
  private get(threadId: string): BrowserSession {
    const session = this.sessions.get(threadId);
    if (!session || session.state.closed) throw new Error("Browser session not open");
    return session;
  }
  evaluateGrantsList(threadId: string) {
    return this.options.evaluateGrants?.list(threadId) ?? [];
  }
  evaluateGrantsRevoke(threadId: string, origin: string): void {
    if (!this.options.evaluateGrants) throw new Error("Evaluate grants unavailable");
    this.options.evaluateGrants.revoke(threadId, origin);
  }
  downloadsList(threadId: string) {
    return this.get(threadId).state.downloads ?? [];
  }
  originsList(threadId: string) {
    return this.options.origins?.list(threadId) ?? [];
  }
  originsGrant(threadId: string, origin: string): void {
    if (!this.options.origins) throw new Error("Browser origin grants unavailable");
    this.options.origins.grant(threadId, origin);
  }
  originsRevoke(threadId: string, origin: string): void {
    if (!this.options.origins) throw new Error("Browser origin grants unavailable");
    this.options.origins.revoke(threadId, origin);
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
  /** Bound JPEG bytes from the owned page, without interpreting an artifact path. */
  screenshot(threadId: string, signal?: AbortSignal, tabId?: string): Promise<Uint8Array> {
    return this.get(threadId).screenshot(signal, tabId);
  }
  input(threadId: string, input: unknown, connectionId: string): Promise<void> {
    return this.get(threadId).input(input, connectionId);
  }
  takeover(
    threadId: string,
    connectionId: string,
    mode: "shared" | "private" = "shared",
  ): BrowserState {
    return this.get(threadId).takeover(connectionId, mode);
  }
  handback(threadId: string, connectionId: string): BrowserState {
    return this.get(threadId).handback(connectionId);
  }
  disconnect(connectionId: string): void {
    for (const session of this.sessions.values()) session.disconnect(connectionId);
  }
  subscribe(
    threadId: string,
    connectionId: string,
    sink: FrameSink,
    onState: (state: BrowserState) => void,
    onBackendEvent?: (event: BrowserBackendLost) => void,
  ): () => void {
    const session = this.get(threadId);
    return this.subscriptions.add(threadId, session.live.fanout, session.state, {
      connectionId,
      sink,
      state: onState,
      ...(onBackendEvent ? { backendLost: onBackendEvent } : {}),
    });
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
  stopRecording(threadId: string): Promise<BrowserArtifact> {
    return this.get(threadId).stopRecording();
  }
  async closeThread(threadId: string, actor?: Actor, signal?: AbortSignal): Promise<void> {
    // Agent closure must not revoke policies or start recovery cleanup before ownership is checked.
    const current = this.sessions.get(threadId);
    if (actor && current) {
      await current.closeBy(actor, signal);
      this.sessions.delete(threadId);
      return;
    }
    signal?.throwIfAborted();
    this.policyScopes.get(threadId)?.abort();
    await this.recoveries.get(threadId);
    const session = this.sessions.get(threadId) ?? (await this.opening.get(threadId));
    if (session) {
      await (actor ? session.closeBy(actor, signal) : session.close());
      this.sessions.delete(threadId);
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      this.embedded?.disconnect("Browser service shutting down");
      await Promise.allSettled(this.recoveries.values());
      await Promise.allSettled(this.opening.values());
      if (this.acquiring) await Promise.allSettled([this.acquiring]);
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => session.close()),
      );
      this.sessions.clear();
      this.policyScopes.clear();
      this.subscriptions.clear();
      this.downloadListeners.clear();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.closing;
  }
}
