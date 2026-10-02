import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext } from "playwright-core";
import {
  BrowserOpen,
  type BrowserArtifact,
  type BrowserState,
  type BrowserFrame,
} from "@ace/protocol";
import { detectChromium, detectFfmpeg } from "./discovery.ts";
import { allowedOrigin, type OriginPolicy } from "./policy.ts";
import { BrowserSession, type Actor } from "./session.ts";
import type { FrameSink } from "./fanout.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { PolicyGate } from "./policy-call.ts";
import { setMaxListeners } from "node:events";
import { launchContext, type ContextLauncher, type ProcessSpawner } from "./io.ts";

export interface BrowserServiceOptions {
  dataDir: string;
  executablePath?: string;
  ffmpeg?: string;
  originPolicy?: OriginPolicy;
  evaluatePolicy?: (
    threadId: string,
    url: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  onArtifact?: (threadId: string, artifact: BrowserArtifact) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  id?: () => string;
  maxSessions?: number;
  launchContext?: ContextLauncher;
  spawn?: ProcessSpawner;
}

export class BrowserService {
  private options: BrowserServiceOptions;
  private sessions = new Map<string, BrowserSession>();
  private opening = new Map<string, Promise<BrowserSession>>();
  private leases = new Set<string>();
  private listeners = new Map<string, Set<(state: BrowserState) => void>>();
  private frameMessages = new WeakMap<BrowserFrame, string>();
  private now: () => number;
  private id: () => string;
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  private policyGate = new PolicyGate();
  private policyScopes = new Map<string, AbortController>();
  constructor(options: BrowserServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }
  async open(raw: unknown): Promise<BrowserState> {
    if (this.closing) throw new Error("Browser service shutting down");
    const options = BrowserOpen.parse(raw);
    const existing = this.sessions.get(options.threadId);
    if (existing && !existing.state.closed) return existing.state;
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
    const executablePath = await detectChromium({
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      dataDir: this.options.dataDir,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
    });
    if (!executablePath)
      throw new Error("No Chromium available; use installChromium(dataDir) to download it");
    const root = join(this.options.dataDir, "browser");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const workspaceKey = createHash("sha256").update(options.workspaceId).digest("hex");
    const persistent = options.profile === "persistent";
    const profile = persistent
      ? join(root, "profiles", workspaceKey)
      : await mkdtemp(join(root, "ephemeral-"));
    if (this.leases.has(profile)) throw new Error("Workspace browser profile is already in use");
    this.leases.add(profile);
    let context: BrowserContext | undefined;
    let session: BrowserSession | undefined;
    const release = async () => {
      if (session && this.sessions.get(options.threadId) === session)
        this.sessions.delete(options.threadId);
      scope.abort();
      if (this.policyScopes.get(options.threadId) === scope)
        this.policyScopes.delete(options.threadId);
      this.leases.delete(profile);
      if (!persistent) await rm(profile, { recursive: true, force: true });
    };
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      context = await (this.options.launchContext ?? launchContext)(profile, {
        executablePath,
        headless: !options.headed,
        viewport: { width: 1280, height: 720 },
        serviceWorkers: "block",
        acceptDownloads: false,
        chromiumSandbox: true,
        timeout: 30_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      const allowed = (url: string) =>
        allowedOrigin(
          options.threadId,
          url,
          this.options.originPolicy
            ? (request) =>
                this.policyGate.run(
                  signal,
                  () => this.options.originPolicy?.({ ...request, signal }) ?? false,
                )
            : undefined,
        );
      await context.routeWebSocket("**/*", async (route) => {
        try {
          if (await allowed(route.url())) route.connectToServer();
          else route.close();
        } catch {
          route.close();
        }
      });
      const page = context.pages()[0] ?? (await context.newPage());
      context.on("page", (popup) => {
        if (popup !== page) void popup.close().catch(() => {});
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      const cdp = await context.newCDPSession(page);
      const guard = await installOriginGuard(cdp, allowed);
      context.once("close", () => guard.close());
      // Playwright routing only intercepts the first hop of a redirect. CDP Fetch
      // checks every hop on the primary page; this route rejects popup requests.
      await context.route("**/*", async (route) => {
        try {
          await guard.ready();
          if (route.request().frame().page() === page && (await allowed(route.request().url())))
            await route.continue();
          else await route.abort("blockedbyclient");
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      const dir = await mkdtemp(join(root, "session-"));
      const ffmpeg = this.options.ffmpeg ?? (await detectFfmpeg());
      session = new BrowserSession({
        threadId: options.threadId,
        context,
        page,
        cdp,
        dir,
        now: this.now,
        id: this.id,
        navigatePolicy: allowed,
        cancelPolicy: () => scope.abort(),
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(ffmpeg ? { ffmpeg } : {}),
        ...(this.options.evaluatePolicy
          ? {
              evaluatePolicy: (threadId: string, url: string) =>
                this.policyGate.run(
                  signal,
                  () => this.options.evaluatePolicy?.(threadId, url, signal) ?? false,
                ),
            }
          : {}),
        artifact: (artifact) => this.options.onArtifact?.(options.threadId, artifact),
        state: (state) => this.emit(state),
        cleanup: async () => {
          guard.close();
          await release();
        },
      });
      const owned = session;
      context.once("close", () => {
        void owned.close().catch((error: unknown) => this.options.onError?.(error));
      });
      page.once("close", () => {
        void owned.close().catch((error: unknown) => this.options.onError?.(error));
      });
      await session.live.start();
      this.sessions.set(options.threadId, session);
      this.emit(session.state);
      return session;
    } catch (error) {
      await context?.close().catch(() => {});
      await release();
      throw error;
    }
  }
  private get(threadId: string): BrowserSession {
    const session = this.sessions.get(threadId);
    if (!session || session.state.closed) throw new Error("Browser session not open");
    return session;
  }
  state(threadId: string): BrowserState {
    return this.get(threadId).state;
  }
  execute(threadId: string, command: unknown, actor?: Actor): Promise<unknown> {
    return this.get(threadId).execute(command, actor);
  }
  input(threadId: string, input: unknown, connectionId: string): Promise<void> {
    return this.get(threadId).input(input, connectionId);
  }
  takeover(threadId: string, connectionId: string): BrowserState {
    return this.get(threadId).takeover(connectionId);
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
  ): () => void {
    const session = this.get(threadId);
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    if (listeners.size >= 64) throw new Error("Browser subscriber limit");
    const stop = session.live.fanout.subscribe(connectionId, sink);
    listeners.add(onState);
    const unsubscribe = () => {
      stop();
      listeners.delete(onState);
      if (!listeners.size && this.listeners.get(threadId) === listeners)
        this.listeners.delete(threadId);
    };
    try {
      onState(session.state);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
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
    for (const listener of this.listeners.get(state.threadId) ?? []) {
      try {
        listener(state);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    if (state.closed) {
      this.listeners.get(state.threadId)?.clear();
      this.listeners.delete(state.threadId);
    }
  }
  startRecording(threadId: string): Promise<void> {
    return this.get(threadId).startRecording();
  }
  stopRecording(threadId: string): Promise<BrowserArtifact> {
    return this.get(threadId).stopRecording();
  }
  async closeThread(threadId: string): Promise<void> {
    this.policyScopes.get(threadId)?.abort();
    const session = this.sessions.get(threadId) ?? (await this.opening.get(threadId));
    if (session) {
      await session.close();
      this.sessions.delete(threadId);
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled(this.opening.values());
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => session.close()),
      );
      this.sessions.clear();
      this.policyScopes.clear();
      this.listeners.clear();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.closing;
  }
}
