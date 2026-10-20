import { z } from "zod";
import { traceBatches } from "./trace-batches.ts";
import { compactPolicyEvent } from "@ace/browser/policy-events";
import {
  type BrowserOpen,
  type BrowserBackendClientMessage,
  type BrowserBackendOperation,
  type BrowserBackendRequest,
  type BrowserBackendServerMessage,
  browserSessionLimit,
} from "@ace/protocol";

/** Relay limits from ADR 0055; the daemon's relay disconnects a backend that exceeds them. */
const relayLimits = {
  /** Any one command, result or event, serialized. */
  messageBytes: 1024 * 1024,
  /** One encoded screencast frame. */
  frameBytes: 768 * 1024,
  sessions: browserSessionLimit,
} as const;

/** One embedded browser view, as the backend sees it (a WebContentsView in the app). */
export interface ViewPage {
  /** Exact CDP: the result is relayed to the daemon unchanged. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** CDP events, plus `ace.permissionDenied`, `ace.downloadDenied` and `Inspector.detached`. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
  /** The person pressed a key, clicked or scrolled in a tab (`tabId` when it has several). */
  onHumanInput(listener: (tabId?: string) => void): () => void;
  /** Resolves with the final URL once the main frame fired DOMContentLoaded. */
  navigate(url: string, timeoutMs: number): Promise<string>;
  /** A Playwright-compatible key or chord. */
  press(key: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  /** Whether the person's own pointer and keyboard reach the page. */
  setNativeInput(enabled: boolean): void;
  /** Whether an agent uses the shown tab (it then intercepts file choosers and renders unseen). */
  setAgentControl?(agent: boolean): void;
  snapshot?(): { activeTabId: string; tabs: { tabId: string; url: string; title: string }[] };
  url(): string;
  /** The daemon link dropped: keep the page alive, refusing what only the daemon decides. */
  orphan?(): void;
  /**
   * A reconnected daemon adopts the page: a fresh CDP session over the same document, with
   * nothing paused, captured or emulated from before. Throws when the page is not worth
   * keeping (it crashed); the backend then opens a new one.
   */
  readopt?(): Promise<void>;
  /** Destroy the view, detach CDP and drop ephemeral partition data. */
  close(): Promise<void>;
}

export interface ViewHost {
  open(request: {
    sessionId: string;
    downloadDir?: string | undefined;
    options: BrowserOpen;
    viewport: { width: number; height: number };
  }): Promise<ViewPage>;
  /** A deleted thread's persistent partition: drop all its data. */
  purge?(request: { threadId: string; workspaceId: string }): Promise<void>;
}

/**
 * The registered backend socket. `send` gets the message already serialized; it returns
 * false when the socket refused it, and the connection then drops the backend.
 */
export interface BackendLink {
  backendId: string;
  connectionId: string;
  send(serialized: string): boolean;
}

export interface BackendOptions {
  /** How long a page outlives a lost daemon link, waiting to be adopted again. */
  orphanGraceMs?: number;
  timers?: { set(delayMs: number, callback: () => void): () => void };
  /**
   * Whether a new view would draw now. A locked or sleeping Mac draws nothing, so a view opened
   * then never gives a picture; the daemon is told at once and opens the page in ace's own
   * Chromium instead. Absent: always.
   */
  drawable?: () => boolean;
  log(message: string): void;
}

const TabTrace = z.looseObject({
  tabId: z.string().max(256),
  method: z.literal("Tracing.dataCollected"),
  params: z.unknown(),
});

const Frame = z.object({ data: z.string(), sessionId: z.number().int() });

interface PendingOpen {
  threadId: string;
  canceled: boolean;
  settled: Promise<void>;
  finish(): void;
}

/** A page whose daemon link dropped, kept for the daemon to adopt when it is back. */
interface Orphan {
  options: BrowserOpen;
  page: ViewPage;
  /** Stop waiting: the page is adopted or closed. */
  release(): void;
}

/** Ten minutes: a daemon restart or a laptop lid closing for a while. */
const defaultOrphanGraceMs = 10 * 60_000;
const defaultTimers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

interface Session {
  id: string;
  threadId: string;
  options: BrowserOpen;
  page: ViewPage;
  stops: (() => void)[];
  /** The CDP screencast frame id sent and not yet acknowledged by the daemon. */
  inFlight: number | undefined;
  /** The newest frame waiting for that acknowledgement; replaced, never queued. */
  latest: { frameId: number; params: unknown } | undefined;
}

/**
 * The desktop side of the embedded browser backend (ADR 0055, version 1). The daemon sends
 * `browser.backend.request` operations; each gets exactly one `browser.backend.response`
 * with the same ids. CDP events are forwarded at once. Screencast frames keep one in flight
 * and one replaceable latest frame per session, released by the daemon's `frameAck`.
 * The person's own input always reaches the view they see; the daemon hears about it
 * (`ace.humanInput`) so agents in that tab wait for them (ADR 0067, collaboration).
 *
 * A dropped link does not close the views. Each stays alive, refusing loads only the daemon may
 * approve, for `orphanGraceMs`; a daemon that opens a session for the same thread and profile
 * again gets the existing page back (`adopted: true` in the open result), not a new one it
 * would have to navigate. Quit (`closeAll`) closes everything.
 */
export class BrowserBackend {
  private sessions = new Map<string, Session>();
  private opening = new Map<string, PendingOpen>();
  /** Pages of a lost link, by thread, until adopted or expired. */
  private orphans = new Map<string, Orphan>();
  private purging = new Set<string>();
  private link: BackendLink | undefined;
  private host: ViewHost;
  private options: BackendOptions;

  constructor(host: ViewHost, options: BackendOptions) {
    this.host = host;
    this.options = options;
  }

  /** The daemon accepted this app's registration on a new connection. */
  attach(link: BackendLink): void {
    this.detach();
    this.link = link;
  }

  /**
   * The connection is gone. The daemon has already dropped every session of this backend and
   * never reuses their ids; the pages wait, orphaned, for it to adopt them again.
   */
  detach(): void {
    this.link = undefined;
    for (const pending of this.opening.values()) pending.canceled = true;
    for (const session of this.sessions.values()) {
      this.sessions.delete(session.id);
      for (const stop of session.stops.splice(0)) stop();
      this.keepOrphan(session.options, session.page);
    }
  }

  /**
   * Quit: every view closes, orphaned or not. Resolves once they are gone; Electron does not
   * finish quitting while a view's page is still alive.
   */
  async closeAll(): Promise<void> {
    this.link = undefined;
    for (const pending of this.opening.values()) pending.canceled = true;
    await Promise.all([
      ...[...this.sessions.values()].map((session) => this.dispose(session)),
      ...[...this.orphans.keys()].map((threadId) => this.closeOrphan(threadId)),
    ]);
  }

  /** Threads whose page waits for a daemon to adopt it. */
  orphaned(): string[] {
    return [...this.orphans.keys()];
  }

  private keepOrphan(options: BrowserOpen, page: ViewPage): void {
    const threadId = options.threadId;
    page.orphan?.();
    const forget = () => {
      if (this.orphans.get(threadId) === orphan) void this.closeOrphan(threadId);
    };
    const cancel = (this.options.timers ?? defaultTimers).set(
      this.options.orphanGraceMs ?? defaultOrphanGraceMs,
      forget,
    );
    // A page that dies while it waits has nothing left to adopt.
    const stop = page.onEvent((method) => {
      if (method === "Inspector.detached") forget();
    });
    const orphan: Orphan = {
      options,
      page,
      release: () => {
        cancel();
        stop();
      },
    };
    this.orphans.set(threadId, orphan);
  }

  /** The thread's orphaned page, removed from waiting; undefined when there is none. */
  private takeOrphan(threadId: string): Orphan | undefined {
    const orphan = this.orphans.get(threadId);
    if (!orphan) return undefined;
    this.orphans.delete(threadId);
    orphan.release();
    return orphan;
  }

  private async closeOrphan(threadId: string): Promise<void> {
    const orphan = this.takeOrphan(threadId);
    await orphan?.page.close().catch((error: unknown) => this.options.log(String(error)));
  }

  /** The orphaned page for this open, adopted with a fresh CDP session; undefined if none fits. */
  private async adopt(options: BrowserOpen): Promise<ViewPage | undefined> {
    const orphan = this.takeOrphan(options.threadId);
    if (!orphan) return undefined;
    const fits =
      orphan.options.workspaceId === options.workspaceId &&
      orphan.options.profile === options.profile &&
      orphan.page.readopt !== undefined;
    try {
      if (!fits) throw new Error("A different browser profile was asked for");
      await orphan.page.readopt?.();
      return orphan.page;
    } catch {
      await orphan.page.close().catch((error: unknown) => this.options.log(String(error)));
      return undefined;
    }
  }

  handle(message: BrowserBackendServerMessage): void {
    const link = this.link;
    if (!link || message.type === "browser.backend.registered") return;
    if (message.backendId !== link.backendId) return;
    if (message.type === "browser.backend.frameAck") {
      const session = this.sessions.get(message.sessionId);
      if (!session || session.inFlight !== message.frameId) return;
      session.inFlight = undefined;
      const latest = session.latest;
      session.latest = undefined;
      if (latest) this.sendFrame(session, latest.frameId, latest.params);
      return;
    }
    void this.request(link, message);
  }

  private async request(link: BackendLink, request: BrowserBackendRequest): Promise<void> {
    let result: unknown;
    try {
      result = (await this.run(link, request.sessionId, request.operation)) ?? {};
    } catch (error) {
      this.respond(link, request, {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
      });
      return;
    }
    this.respond(link, request, { result });
  }

  private async run(
    link: BackendLink,
    sessionId: string,
    operation: BrowserBackendOperation,
  ): Promise<unknown> {
    if (operation.kind === "open") return this.open(link, sessionId, operation);
    if (operation.kind === "purge") {
      if (this.purging.has(operation.threadId))
        throw new Error("Browser partition purge in progress");
      this.purging.add(operation.threadId);
      try {
        const pending = [...this.opening.values()].filter(
          (entry) => entry.threadId === operation.threadId,
        );
        for (const entry of pending) entry.canceled = true;
        const open = this.byThread(operation.threadId);
        if (open) await this.dispose(open);
        await this.closeOrphan(operation.threadId);
        await Promise.all(pending.map((entry) => entry.settled));
        if (!this.host.purge) throw new Error("Browser partition purge unavailable");
        await this.host.purge({ threadId: operation.threadId, workspaceId: operation.workspaceId });
        return {};
      } finally {
        this.purging.delete(operation.threadId);
      }
    }
    const pending = this.opening.get(sessionId);
    if (operation.kind === "close" && pending) {
      // Fence ownership now, even if native creation cannot be interrupted.
      pending.canceled = true;
      return {};
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown browser session");
    switch (operation.kind) {
      case "cdp":
        return session.page.cdp(operation.method, operation.params);
      case "navigate":
        return { url: await session.page.navigate(operation.url, operation.timeout) };
      case "press":
        await session.page.press(operation.key);
        return {};
      case "resize":
        await session.page.resize(operation.width, operation.height);
        return {};
      case "agentUse":
        session.page.setAgentControl?.(operation.active);
        return {};
      case "close":
        await this.dispose(session);
        return {};
    }
  }

  private async open(
    link: BackendLink,
    sessionId: string,
    operation: Extract<BrowserBackendOperation, { kind: "open" }>,
  ): Promise<unknown> {
    if (this.sessions.has(sessionId) || this.opening.has(sessionId))
      throw new Error("Browser session already open");
    if (this.sessions.size + this.opening.size >= relayLimits.sessions)
      throw new Error("Embedded browser session limit");
    if (this.purging.has(operation.options.threadId))
      throw new Error("Browser partition purge in progress");
    // A page kept from before stays this app's; only a new view needs the screen to draw.
    if (this.options.drawable?.() === false && !this.orphans.has(operation.options.threadId))
      throw new Error("The desktop can't draw pages while its screen is locked or asleep");
    const completion = Promise.withResolvers<void>();
    const pending: PendingOpen = {
      threadId: operation.options.threadId,
      canceled: false,
      settled: completion.promise,
      finish: completion.resolve,
    };
    this.opening.set(sessionId, pending);
    try {
      const adopted = await this.adopt(operation.options);
      const page =
        adopted ??
        (await this.host.open({
          sessionId,
          downloadDir: operation.downloadDir,
          options: operation.options,
          viewport: operation.viewport,
        }));
      if (pending.canceled || this.link !== link) {
        // The connection dropped while the view was being made; the daemon forgot the session.
        // An adopted page goes back to waiting for the next connection.
        if (adopted && !this.purging.has(operation.options.threadId))
          this.keepOrphan(operation.options, adopted);
        else await page.close().catch(() => {});
        throw new Error("Desktop browser open canceled");
      }
      const session: Session = {
        id: sessionId,
        threadId: operation.options.threadId,
        options: operation.options,
        page,
        stops: [],
        inFlight: undefined,
        latest: undefined,
      };
      this.sessions.set(sessionId, session);
      session.stops.push(
        page.onEvent((method, params) => this.event(session, method, params)),
        page.onHumanInput((tabId) => this.humanInput(session, tabId)),
      );
      // People and agents share the page: the person's input always reaches what they see.
      page.setNativeInput(true);
      page.setAgentControl?.(false);
      return { url: page.url(), ...page.snapshot?.(), ...(adopted ? { adopted: true } : {}) };
    } finally {
      this.opening.delete(sessionId);
      pending.finish();
    }
  }

  private humanInput(session: Session, tabId: string | undefined): void {
    const link = this.link;
    if (!link || this.sessions.get(session.id) !== session) return;
    this.send({
      type: "browser.backend.event",
      backendId: link.backendId,
      sessionId: session.id,
      method: "ace.humanInput",
      params: tabId === undefined ? {} : { tabId },
    });
  }

  private event(session: Session, method: string, params: unknown): void {
    const link = this.link;
    if (!link || this.sessions.get(session.id) !== session) return;
    if (method === "Page.screencastFrame") return this.frame(session, params);
    const nested = method === "ace.tabs.event" ? TabTrace.safeParse(params) : undefined;
    if (method === "Tracing.dataCollected" || nested?.success) {
      for (const batch of traceBatches(nested?.success ? nested.data.params : params)) {
        this.send({
          type: "browser.backend.event",
          backendId: link.backendId,
          sessionId: session.id,
          method,
          params: nested?.success ? { ...nested.data, params: batch } : batch,
        });
      }
      return;
    }
    const policyEvent = [
      "Fetch.requestPaused",
      "Target.receivedMessageFromTarget",
      "ace.tabs.event",
    ].includes(method);
    let forwarded: unknown;
    try {
      forwarded = compactPolicyEvent(method, params);
    } catch {
      this.losePolicySession(session);
      return;
    }
    const sent = this.send({
      type: "browser.backend.event",
      backendId: link.backendId,
      sessionId: session.id,
      method,
      params: forwarded,
    });
    if (!sent && policyEvent) {
      this.losePolicySession(session);
      return;
    }
    // The view is gone (closed by the person, crashed, or the debugger detached).
    if (method === "Inspector.detached") void this.dispose(session);
  }

  private losePolicySession(session: Session): void {
    const link = this.link;
    if (!link) return;
    this.send({
      type: "browser.backend.event",
      backendId: link.backendId,
      sessionId: session.id,
      method: "Inspector.detached",
      params: { reason: "Browser policy event payload limit" },
    });
    void this.dispose(session);
  }

  private frame(session: Session, params: unknown): void {
    const frame = Frame.safeParse(params);
    if (!frame.success) return;
    // Chromium waits for this before producing the next frame; never wait for the daemon.
    void session.page
      .cdp("Page.screencastFrameAck", { sessionId: frame.data.sessionId })
      .catch(() => {});
    if (frame.data.data.length > relayLimits.frameBytes) return;
    if (session.inFlight !== undefined) {
      session.latest = { frameId: frame.data.sessionId, params };
      return;
    }
    this.sendFrame(session, frame.data.sessionId, params);
  }

  private sendFrame(session: Session, frameId: number, params: unknown): void {
    const link = this.link;
    if (!link) return;
    session.inFlight = frameId;
    this.send({
      type: "browser.backend.event",
      backendId: link.backendId,
      sessionId: session.id,
      method: "Page.screencastFrame",
      params,
    });
  }

  private respond(
    link: BackendLink,
    request: BrowserBackendRequest,
    outcome: { result: unknown } | { error: string },
  ): void {
    if (this.link !== link) return;
    const ids = {
      type: "browser.backend.response" as const,
      backendId: request.backendId,
      sessionId: request.sessionId,
      id: request.id,
    };
    // A result over the relay limit still gets its one response, as an error.
    if (!this.send({ ...ids, ...outcome }))
      this.send({ ...ids, error: "Browser relay payload limit" });
  }

  /** Serializes once; false when the message is over the relay limit and was not sent. */
  private send(message: BrowserBackendClientMessage): boolean {
    const link = this.link;
    if (!link) return true;
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > relayLimits.messageBytes) {
      this.options.log(`Dropped an oversized ${message.type} from the embedded browser`);
      return false;
    }
    link.send(serialized);
    return true;
  }

  private async dispose(session: Session): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    for (const stop of session.stops.splice(0)) stop();
    await session.page.close().catch((error: unknown) => this.options.log(String(error)));
  }

  private byThread(threadId: string): Session | undefined {
    for (const session of this.sessions.values()) if (session.threadId === threadId) return session;
    return undefined;
  }
}
