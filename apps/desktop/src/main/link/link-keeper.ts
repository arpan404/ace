import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";

export interface Endpoint {
  url: string;
  token: string;
}

/** The daemon's lifecycle as the app sees it (the runtime, or its supervisor in tests). */
export interface LinkSource {
  current(): DaemonStatus;
  onStatus(listener: (status: DaemonStatus) => void): () => void;
  /** The running daemon's address; may reject or be undefined when there is none. */
  connection(): Promise<Endpoint | undefined>;
}

/** The app's daemon runtime as a link source: only daemon targets have an address. */
export function runtimeLinkSource(runtime: {
  current(): DaemonStatus;
  onStatus(listener: (status: DaemonStatus) => void): () => void;
  connection(): Promise<DaemonConnection>;
}): LinkSource {
  return {
    current: () => runtime.current(),
    onStatus: (listener) => runtime.onStatus(listener),
    connection: async () => {
      const connection = await runtime.connection();
      return connection.mode === "daemon" ? connection : undefined;
    },
  };
}

export interface KeptLink {
  start(): Promise<void>;
  close(): Promise<void>;
  /** Reconnect now (the daemon came back at the same address). */
  wake(): void;
  /** The link gave up for good (for example, its token was refused). */
  fatal(): boolean;
}

/**
 * Keeps the app's daemon link attached for the app's whole lifetime. Every time the daemon
 * becomes ready (first start, crash restart, repair, a slow start that finally answers) the
 * link is created, revived, or replaced when the daemon's address or token changed. A failed
 * first start therefore never leaves notifications, the badge or the tray dead.
 */
export class LinkKeeper<L extends KeptLink> {
  private source: LinkSource;
  private create: (endpoint: Endpoint) => L | Promise<L>;
  private log: (message: string) => void;
  private attached: { link: L; endpoint: Endpoint } | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stop: (() => void) | undefined;
  private closed = false;

  constructor(
    source: LinkSource,
    /** Makes a link; may load its code first (the app imports the link lazily). */
    create: (endpoint: Endpoint) => L | Promise<L>,
    log: (message: string) => void,
  ) {
    this.source = source;
    this.create = create;
    this.log = log;
  }

  start(): void {
    if (this.stop || this.closed) return;
    this.stop = this.source.onStatus((status) => {
      if (status.state === "running") this.sync();
    });
    if (this.source.current().state === "running") this.sync();
  }

  /** The attached link, if any. */
  link(): L | undefined {
    return this.attached?.link;
  }

  /** The machine woke up: reconnect the link now. */
  wake(): void {
    this.attached?.link.wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop?.();
    await this.queue;
    const attached = this.attached;
    this.attached = undefined;
    await attached?.link.close().catch(() => {});
  }

  /** Attach to the running daemon; runs one at a time, in order. */
  private sync(): void {
    this.queue = this.queue
      .then(() => this.attach())
      .catch((error: unknown) => this.log(`Daemon link: ${String(error)}`));
  }

  private async attach(): Promise<void> {
    if (this.closed) return;
    const endpoint = await this.source.connection().catch(() => undefined);
    if (!endpoint || this.closed) return;
    const current = this.attached;
    if (
      current &&
      current.endpoint.url === endpoint.url &&
      current.endpoint.token === endpoint.token &&
      !current.link.fatal()
    ) {
      current.link.wake();
      return;
    }
    if (current) {
      this.attached = undefined;
      await current.link.close().catch(() => {});
    }
    const link = await this.create(endpoint);
    if (this.closed) {
      await link.close().catch(() => {});
      return;
    }
    this.attached = { link, endpoint };
    try {
      await link.start();
    } catch (error) {
      // The next time the daemon is ready, a fresh link is made.
      if (this.attached?.link === link) this.attached = undefined;
      await link.close().catch(() => {});
      throw error;
    }
  }
}
