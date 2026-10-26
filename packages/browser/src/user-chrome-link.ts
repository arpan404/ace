import { EventEmitter } from "node:events";
import {
  UserBrowserExtensionMessage,
  type UserBrowserDaemonMessage,
  type UserBrowserDetachReason,
  type UserBrowserDownload,
  type UserBrowserIdentity,
  type UserBrowserOperation,
  type UserBrowserTab,
} from "@ace/protocol";
import { browserWaitLimitMs } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import { CommandSlots } from "./command-slots.ts";
import type { NavigationClock } from "./navigation.ts";

/** The socket to one browser profile's native host. No send queue: a refused write loses it. */
export interface UserChromeTransport {
  send(message: UserBrowserDaemonMessage): boolean;
  close(reason: string): void;
}

/** A CDP surface for one tab of the person's browser, relayed through the extension. */
export interface UserTabCdp extends BrowserCdp {
  readonly tabId: number;
  /** One of the tab's out-of-process iframes, by its child session id. */
  session(sessionId: string): BrowserCdp;
  /** The iframe's session ended: its listeners go. */
  endSession(sessionId: string): void;
  /** Called once when the tab stops being controllable, with the extension's reason. */
  onDetached(listener: (reason: UserBrowserDetachReason | "disconnected") => void): () => void;
  dispose(): void;
}

const navigationDeadlineMs = browserWaitLimitMs + 5_000;
function deadline(operation: UserBrowserOperation): number {
  if (operation.op === "tabs.open") return 60_000;
  if (operation.op === "cdp" && operation.method === "Page.navigate") return navigationDeadlineMs;
  return 30_000;
}

/**
 * Chrome refuses a tab's commands while its page moves between renderer processes (a fresh tab's
 * first navigation, a cross-site one). A refused command never ran, so it is sent again once the
 * tab reports progress (an event or a new tab state) or after a short wait, within a budget.
 */
const betweenProcesses = "Not attached to an active page";
const refusedRetryMs = [50, 100, 200, 400, 800, 1_600, 3_200];

interface Waiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancel(): void;
}

/**
 * One connected browser profile (ADR 0084): correlates commands with replies, routes CDP events
 * to the tab they belong to, and reports a tab's or the whole link's loss. Every command has a
 * deadline; the link never replays one the browser may have run.
 */
export class UserChromeLink {
  readonly connectionId: string;
  readonly browser: UserBrowserIdentity;
  readonly connectedAt: number;
  private transport: UserChromeTransport;
  /** The daemon's monotonic clock, for timing on this browser's tabs. */
  readonly clock: NavigationClock;
  private pending = new Map<string, Waiter>();
  private slots = new CommandSlots(64, 1024);
  private sequence = 0;
  private events = new EventEmitter();
  private tabList: UserBrowserTab[] = [];
  private closedReason: string | undefined;
  constructor(options: {
    connectionId: string;
    browser: UserBrowserIdentity;
    connectedAt: number;
    transport: UserChromeTransport;
    clock: NavigationClock;
  }) {
    this.connectionId = options.connectionId;
    this.browser = options.browser;
    this.connectedAt = options.connectedAt;
    this.transport = options.transport;
    this.clock = options.clock;
    this.events.setMaxListeners(0);
  }
  get closed(): boolean {
    return this.closedReason !== undefined;
  }
  /** The tabs the person shared and the tabs agents opened, as the extension last reported. */
  tabs(): UserBrowserTab[] {
    return this.tabList;
  }
  onTabsChanged(listener: () => void): () => void {
    this.events.on("tabs", listener);
    return () => this.events.off("tabs", listener);
  }
  /** Downloads one of this browser's tabs started, as the browser saved them (ADR 0086). */
  onDownload(tabId: number, listener: (download: UserBrowserDownload) => void): () => void {
    this.events.on(`download:${tabId}`, listener);
    return () => this.events.off(`download:${tabId}`, listener);
  }
  onClosed(listener: (reason: string) => void): () => void {
    this.events.on("closed", listener);
    return () => this.events.off("closed", listener);
  }
  /** A message from the extension, already authenticated by its socket. Unknown input is ignored. */
  handle(raw: unknown): void {
    const parsed = UserBrowserExtensionMessage.safeParse(raw);
    if (!parsed.success || this.closed) return;
    const message = parsed.data;
    if (message.type === "user_browser.reply") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      waiter.cancel();
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error));
      return;
    }
    if (message.type !== "user_browser.event") return;
    const event = message.event;
    if (event.kind === "tabs") {
      this.tabList = event.tabs;
      this.events.emit("tabs");
    } else if (event.kind === "cdp")
      this.events.emit(`cdp:${event.tabId}`, event.method, event.params, event.sessionId);
    else if (event.kind === "download") this.events.emit(`download:${event.tabId}`, event.download);
    else this.events.emit(`detached:${event.tabId}`, event.reason);
  }
  command(operation: UserBrowserOperation, signal?: AbortSignal): Promise<unknown> {
    return this.slots.run(() => this.dispatch(operation, signal), signal);
  }
  private dispatch(operation: UserBrowserOperation, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const abort = () => {
        cancel();
        this.pending.delete(id);
        reject(signal?.reason ?? new Error("Browser command cancelled"));
      };
      const stopTimer = this.clock.set(deadline(operation), () => {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(new Error("Your browser did not answer in time"));
      });
      const cancel = () => {
        stopTimer();
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cancel });
      signal?.addEventListener("abort", abort, { once: true });
      if (!this.transport.send({ type: "user_browser.command", id, operation })) {
        cancel();
        this.pending.delete(id);
        reject(new Error("Your browser's connection is overloaded"));
        this.close("Your browser's connection is overloaded");
      }
    });
  }
  /** Relayed CDP for one tab. Events arrive only while the extension has the tab attached. */
  tab(tabId: number): UserTabCdp {
    type Listeners = Map<string, Set<(params: unknown) => void>>;
    const listeners: Listeners = new Map();
    /** Each iframe session's listeners, by session id. */
    const frames = new Map<string, Listeners>();
    const onCdp = (method: string, params: unknown, sessionId?: string) => {
      const target = sessionId === undefined ? listeners : frames.get(sessionId);
      for (const listener of target?.get(method) ?? []) listener(params);
    };
    const surface = (
      target: Listeners,
      send: BrowserCdp["send"],
    ): Pick<BrowserCdp, "send" | "on" | "off"> => ({
      send,
      on(method, listener) {
        let set = target.get(method);
        if (!set) target.set(method, (set = new Set()));
        set.add(listener);
        return this;
      },
      off(method, listener) {
        target.get(method)?.delete(listener);
        return this;
      },
    });
    const detachedListeners = new Set<(reason: UserBrowserDetachReason | "disconnected") => void>();
    let detached = false;
    const detach = (reason: UserBrowserDetachReason | "disconnected") => {
      if (detached) return;
      detached = true;
      for (const listener of detachedListeners) listener(reason);
    };
    const onDetach = (reason: UserBrowserDetachReason) => detach(reason);
    const onClosed = () => detach("disconnected");
    this.events.on(`cdp:${tabId}`, onCdp);
    this.events.on(`detached:${tabId}`, onDetach);
    this.events.on("closed", onClosed);
    const dispose = () => {
      this.events.off(`cdp:${tabId}`, onCdp);
      this.events.off(`detached:${tabId}`, onDetach);
      this.events.off("closed", onClosed);
      listeners.clear();
      frames.clear();
      detachedListeners.clear();
    };
    const once = (
      sessionId: string | undefined,
      method: string,
      params?: Record<string, unknown>,
    ) =>
      detached
        ? Promise.reject(new Error("This tab is no longer shared with ace"))
        : this.command({
            op: "cdp",
            tabId,
            ...(sessionId === undefined ? {} : { sessionId }),
            method,
            ...(params ? { params } : {}),
          });
    const send =
      (sessionId?: string): BrowserCdp["send"] =>
      async (method, params) => {
        for (const wait of refusedRetryMs) {
          try {
            return await once(sessionId, method, params);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes(betweenProcesses)) throw error;
          }
          await this.progress(tabId, wait);
        }
        return once(sessionId, method, params);
      };
    return {
      tabId,
      ...surface(listeners, send()),
      session(sessionId) {
        let target = frames.get(sessionId);
        if (!target) frames.set(sessionId, (target = new Map()));
        return surface(target, send(sessionId));
      },
      endSession: (sessionId) => void frames.delete(sessionId),
      onDetached(listener) {
        detachedListeners.add(listener);
        return () => detachedListeners.delete(listener);
      },
      dispose,
    };
  }
  /** Resolves on the tab's next event, a new tab list, its detach, the link closing, or `wait`. */
  private progress(tabId: number, wait: number): Promise<void> {
    return new Promise((resolve) => {
      const names = [`cdp:${tabId}`, `detached:${tabId}`, "tabs", "closed"];
      const done = () => {
        stopTimer();
        for (const name of names) this.events.off(name, done);
        resolve();
      };
      const stopTimer = this.clock.set(wait, done);
      for (const name of names) this.events.on(name, done);
    });
  }
  /** The socket closed or the credential was revoked: every command and tab on it fails. */
  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.cancel();
      waiter.reject(new Error(reason));
    }
    this.tabList = [];
    this.events.emit("closed", reason);
    this.events.emit("tabs");
    this.events.removeAllListeners();
    this.transport.close(reason);
  }
}
