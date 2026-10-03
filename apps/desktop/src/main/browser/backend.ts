import { z } from "zod";
import {
  type BrowserOpen,
  type BrowserBackendClientMessage,
  type BrowserBackendOperation,
  type BrowserBackendRequest,
  type BrowserBackendServerMessage,
  type BrowserControllerLease,
} from "@ace/protocol";

/** Relay limits from ADR 0055; the daemon's relay disconnects a backend that exceeds them. */
const relayLimits = {
  /** Any one command, result or event, serialized. */
  messageBytes: 1024 * 1024,
  /** One encoded screencast frame. */
  frameBytes: 768 * 1024,
  sessions: 8,
} as const;

/** One embedded browser view, as the backend sees it (a WebContentsView in the app). */
export interface ViewPage {
  /** Exact CDP: the result is relayed to the daemon unchanged. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** CDP events, plus `ace.permissionDenied`, `ace.downloadDenied` and `Inspector.detached`. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
  /** The person clicked or pressed a key in the view while its native input was off. */
  onBlockedInput(listener: () => void): () => void;
  /** Resolves with the final URL once the main frame fired DOMContentLoaded. */
  navigate(url: string, timeoutMs: number): Promise<string>;
  /** A Playwright-compatible key or chord. */
  press(key: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  /** Whether the person's own pointer and keyboard reach the page. */
  setNativeInput(enabled: boolean): void;
  url(): string;
  /** Destroy the view, detach CDP and drop ephemeral partition data. */
  close(): Promise<void>;
}

export interface ViewHost {
  open(request: {
    sessionId: string;
    options: BrowserOpen;
    viewport: { width: number; height: number };
  }): Promise<ViewPage>;
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

export interface ControllerState {
  threadId: string;
  controller: BrowserControllerLease["controller"];
  /** The lease belongs to this app's own connection, so the person can use the view here. */
  here: boolean;
}

export interface BackendOptions {
  onController?(state: ControllerState): void;
  /** The person tried to use a view they do not control: ask the daemon for control. */
  onTakeover?(threadId: string): void;
  log(message: string): void;
}

const Frame = z.object({ data: z.string(), sessionId: z.number().int() });

interface Session {
  id: string;
  threadId: string;
  page: ViewPage;
  lease: BrowserControllerLease;
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
 * Controller leases decide whether the person's own input reaches a view.
 */
export class BrowserBackend {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
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
   * The connection is gone. The daemon has already dropped every session of this backend
   * and never reuses their ids, so the views close here too.
   */
  detach(): void {
    this.link = undefined;
    for (const session of this.sessions.values()) void this.dispose(session);
  }

  /** The thread's embedded session, if one is open here. */
  controller(threadId: string): ControllerState | undefined {
    const session = this.byThread(threadId);
    return session && this.controllerState(session);
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
      case "controller":
        this.applyLease(session, operation.lease);
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
    this.opening.add(sessionId);
    let page: ViewPage;
    try {
      page = await this.host.open({
        sessionId,
        options: operation.options,
        viewport: operation.viewport,
      });
    } finally {
      this.opening.delete(sessionId);
    }
    if (this.link !== link) {
      // The connection dropped while the view was being made; the daemon forgot the session.
      await page.close().catch(() => {});
      throw new Error("Desktop browser backend lost");
    }
    const session: Session = {
      id: sessionId,
      threadId: operation.options.threadId,
      page,
      lease: { generation: -1, controller: "none" },
      stops: [],
      inFlight: undefined,
      latest: undefined,
    };
    this.sessions.set(sessionId, session);
    session.stops.push(
      page.onEvent((method, params) => this.event(session, method, params)),
      page.onBlockedInput(() => {
        if (session.lease.controller !== "human" || session.lease.owner !== link.connectionId)
          this.options.onTakeover?.(session.threadId);
      }),
    );
    this.applyLease(session, operation.lease);
    return { url: page.url() };
  }

  private applyLease(session: Session, lease: BrowserControllerLease): void {
    if (lease.generation < session.lease.generation)
      throw new Error("Obsolete controller lease generation");
    session.lease = lease;
    const here = this.isHere(lease);
    session.page.setNativeInput(here);
    this.options.onController?.(this.controllerState(session));
  }

  private event(session: Session, method: string, params: unknown): void {
    const link = this.link;
    if (!link || this.sessions.get(session.id) !== session) return;
    if (method === "Page.screencastFrame") return this.frame(session, params);
    this.send({
      type: "browser.backend.event",
      backendId: link.backendId,
      sessionId: session.id,
      method,
      params,
    });
    // The view is gone (closed by the person, crashed, or the debugger detached).
    if (method === "Inspector.detached") void this.dispose(session);
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
    session.lease = { generation: session.lease.generation, controller: "none" };
    this.options.onController?.(this.controllerState(session));
    await session.page.close().catch((error: unknown) => this.options.log(String(error)));
  }

  private isHere(lease: BrowserControllerLease): boolean {
    return (
      lease.controller === "human" &&
      this.link !== undefined &&
      lease.owner === this.link.connectionId
    );
  }

  private controllerState(session: Session): ControllerState {
    return {
      threadId: session.threadId,
      controller: session.lease.controller,
      here: this.sessions.has(session.id) && this.isHere(session.lease),
    };
  }

  private byThread(threadId: string): Session | undefined {
    for (const session of this.sessions.values()) if (session.threadId === threadId) return session;
    return undefined;
  }
}
