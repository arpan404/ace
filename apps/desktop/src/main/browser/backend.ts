import { z } from "zod";
import { BackendDown, maxPayloadBytes, type BackendUp, type FrameChannel } from "./contract.ts";
import { ControllerLease, type Controller } from "./lease.ts";

/** One embedded browser view, as the backend sees it (an Electron WebContentsView in the app). */
export interface CdpTarget {
  send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  /** Mouse, keyboard or wheel input from the person in the view. */
  onHumanInput(listener: () => void): () => void;
  url(): string;
  close(): void;
}

export interface ViewHost {
  open(request: {
    sessionId: string;
    workspaceId: string;
    threadId?: string;
    url?: string;
  }): CdpTarget;
}

export interface BackendOptions {
  /** Forwarded CDP events per session per second; the excess is counted and reported. */
  eventsPerSecond?: number;
  now(): number;
  onController?(sessionId: string, controller: Controller): void;
}

const Metadata = z.record(z.string(), z.unknown()).catch({});

/** Event domains worth relaying: navigation, page lifecycle, console and network logs. */
const relayed =
  /^(Page\.(frameNavigated|loadEventFired|domContentEventFired|javascriptDialogOpening)|Runtime\.(consoleAPICalled|exceptionThrown)|Log\.entryAdded|Network\.(requestWillBeSent|responseReceived|loadingFailed))$/;

interface Session {
  target: CdpTarget;
  lease: ControllerLease;
  stops: (() => void)[];
  screencast: boolean;
  /** Frame sent and not yet acknowledged by the daemon. */
  inFlight: boolean;
  /** The newest frame waiting for that acknowledgement; replaced, never queued. */
  latest:
    | Omit<Extract<BackendUp, { type: "browser.backend.frame" }>, "type" | "sessionId">
    | undefined;
  frames: number;
  window: { start: number; count: number; dropped: number };
}

/**
 * Registers this app as the daemon's "embedded" browser backend and relays CDP between the
 * daemon and the app's own browser views. Calls and events are size-bounded, events are
 * rate-limited per session, and screencast frames are flow-controlled by daemon acks with
 * only the latest frame kept.
 */
export class BrowserBackend {
  private sessions = new Map<string, Session>();
  private origins = new Map<number, (allowed: boolean) => void>();
  private nextOrigin = 0;
  private stops: (() => void)[] = [];
  private channel: FrameChannel;
  private host: ViewHost;
  private options: BackendOptions;

  constructor(channel: FrameChannel, host: ViewHost, options: BackendOptions) {
    this.channel = channel;
    this.host = host;
    this.options = options;
    this.stops.push(
      channel.onReady(() => this.register()),
      channel.onFrame((frame) => this.receive(frame)),
      channel.onClose(() => {
        // Undelivered acks die with the socket; resume frames after the next registration.
        for (const session of this.sessions.values()) session.inFlight = false;
        for (const resolve of this.origins.values()) resolve(false);
        this.origins.clear();
      }),
    );
  }

  controller(sessionId: string): Controller | undefined {
    return this.sessions.get(sessionId)?.lease.controller;
  }

  /** The person handed control back from the app UI. */
  handBack(sessionId: string): void {
    this.setController(sessionId, "agent");
  }

  /** Ask the daemon whether a non-local origin may load (a per-site approval interaction). */
  requestOrigin(sessionId: string, origin: string, timeoutMs = 120_000): Promise<boolean> {
    const requestId = this.nextOrigin++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        this.origins.delete(requestId);
        resolve(allowed);
      };
      this.origins.set(requestId, finish);
      this.channel.send({ type: "browser.backend.origin", sessionId, requestId, origin });
    });
  }

  /** App quit: tell the daemon first so it fails over to its headless backend at once. */
  shutdown(): void {
    for (const [sessionId, session] of this.sessions) {
      this.channel.send({ type: "browser.backend.closed", sessionId, reason: "quit" });
      this.dispose(session);
    }
    this.sessions.clear();
    this.channel.send({ type: "browser.backend.unregister", reason: "quit" });
    for (const stop of this.stops.splice(0)) stop();
  }

  private register(): void {
    this.channel.send({
      type: "browser.backend.register",
      backend: "embedded",
      version: 1,
      capabilities: { screencast: true, input: true, takeover: true },
      sessions: [...this.sessions].map(([sessionId, session]) => ({
        sessionId,
        url: session.target.url(),
      })),
    });
  }

  private receive(raw: unknown): void {
    const parsed = BackendDown.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.type === "browser.backend.open") return this.open(frame);
    if (frame.type === "browser.backend.originDecision") {
      this.origins.get(frame.requestId)?.(frame.allowed);
      return;
    }
    const session = this.sessions.get(frame.sessionId);
    if (!session) {
      if (frame.type === "browser.backend.call")
        this.channel.send({ ...result(frame), error: "unknown_session" });
      return;
    }
    switch (frame.type) {
      case "browser.backend.close":
        this.dispose(session);
        this.sessions.delete(frame.sessionId);
        this.channel.send({
          type: "browser.backend.closed",
          sessionId: frame.sessionId,
          reason: "requested",
        });
        return;
      case "browser.backend.call":
        return void this.call(session, frame);
      case "browser.backend.screencast":
        return this.screencast(session, frame.enabled);
      case "browser.backend.ack":
        session.inFlight = false;
        if (session.latest) this.sendFrame(frame.sessionId, session);
        return;
      case "browser.backend.handback":
        return this.setController(frame.sessionId, "agent");
    }
  }

  private open(frame: Extract<BackendDown, { type: "browser.backend.open" }>): void {
    if (this.sessions.has(frame.sessionId)) return;
    const target = this.host.open({
      sessionId: frame.sessionId,
      workspaceId: frame.workspaceId,
      ...(frame.threadId ? { threadId: frame.threadId } : {}),
      ...(frame.url ? { url: frame.url } : {}),
    });
    const session: Session = {
      target,
      lease: new ControllerLease(),
      stops: [],
      screencast: false,
      inFlight: false,
      latest: undefined,
      frames: 0,
      window: { start: this.options.now(), count: 0, dropped: 0 },
    };
    session.stops.push(
      target.onEvent((method, params) => this.event(frame.sessionId, session, method, params)),
      target.onHumanInput(() => this.setController(frame.sessionId, "human")),
    );
    this.sessions.set(frame.sessionId, session);
    this.channel.send({
      type: "browser.backend.opened",
      sessionId: frame.sessionId,
      url: target.url(),
    });
  }

  private async call(
    session: Session,
    frame: Extract<BackendDown, { type: "browser.backend.call" }>,
  ): Promise<void> {
    if (!session.lease.agentMay(frame.method)) {
      this.channel.send({ ...result(frame), error: "human_in_control" });
      return;
    }
    try {
      const value = await session.target.send(frame.method, frame.params);
      if (JSON.stringify(value).length > maxPayloadBytes)
        this.channel.send({ ...result(frame), error: "payload_too_large" });
      else this.channel.send({ ...result(frame), result: value });
    } catch (error) {
      this.channel.send({
        ...result(frame),
        error: String(error instanceof Error ? error.message : error).slice(0, 2000),
      });
    }
  }

  private screencast(session: Session, enabled: boolean): void {
    if (session.screencast === enabled) return;
    session.screencast = enabled;
    session.latest = undefined;
    void session.target
      .send(
        enabled ? "Page.startScreencast" : "Page.stopScreencast",
        enabled ? { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1600 } : {},
      )
      .catch(() => {});
  }

  private event(
    sessionId: string,
    session: Session,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "Page.screencastFrame") {
      // Chrome waits for this ack before producing the next frame.
      void session.target
        .send("Page.screencastFrameAck", { sessionId: params.sessionId })
        .catch(() => {});
      if (!session.screencast || typeof params.data !== "string") return;
      const metadata = Metadata.parse(params.metadata);
      session.latest = { seq: session.frames++, data: params.data, metadata };
      if (!session.inFlight) this.sendFrame(sessionId, session);
      return;
    }
    if (!relayed.test(method)) return;
    const now = this.options.now();
    const window = session.window;
    if (now - window.start >= 1_000) {
      if (window.dropped)
        this.channel.send({
          type: "browser.backend.event",
          sessionId,
          method: "ace.eventsDropped",
          params: { count: window.dropped },
        });
      session.window = { start: now, count: 0, dropped: 0 };
    }
    if (
      session.window.count >= (this.options.eventsPerSecond ?? 200) ||
      JSON.stringify(params).length > 64 * 1024
    ) {
      session.window.dropped++;
      return;
    }
    session.window.count++;
    this.channel.send({ type: "browser.backend.event", sessionId, method, params });
  }

  private sendFrame(sessionId: string, session: Session): void {
    const latest = session.latest;
    if (!latest) return;
    session.latest = undefined;
    session.inFlight = true;
    this.channel.send({ type: "browser.backend.frame", sessionId, ...latest });
  }

  private setController(sessionId: string, controller: Controller): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.lease.take(controller)) return;
    this.channel.send({ type: "browser.backend.controller", sessionId, controller });
    this.options.onController?.(sessionId, controller);
  }

  private dispose(session: Session): void {
    for (const stop of session.stops.splice(0)) stop();
    session.target.close();
  }
}

function result(frame: { sessionId: string; callId: number }) {
  return {
    type: "browser.backend.result" as const,
    sessionId: frame.sessionId,
    callId: frame.callId,
  };
}
