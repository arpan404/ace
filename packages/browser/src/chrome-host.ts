import {
  launchChrome,
  type ChromeCleanup,
  type ChromeInstance,
  type ChromeLaunch,
} from "./chrome-instance.ts";

export interface ChromeHostOptions {
  executable(signal: AbortSignal): Promise<string>;
  profileDir: string;
  stagingDir: string;
  platform: NodeJS.Platform;
  launch: ChromeLaunch;
  cleanup: ChromeCleanup;
}
/** A session's hold on the running browser. The browser is not stopped while any lease is held. */
export interface ChromeLease {
  readonly instance: ChromeInstance;
  release(): void;
}

/**
 * One Chrome per profile, shared by every thread's browser. Started on first use; a crashed
 * or wedged process is replaced by the next `acquire`. With no leases it exits after `idleMs`.
 */
export class ChromeHost {
  private instance: ChromeInstance | undefined;
  private starting: Promise<ChromeInstance> | undefined;
  /** Earlier processes still exiting: a profile has one Chrome at a time. */
  private exiting = new Set<Promise<unknown>>();
  private leases = 0;
  private cancelIdle: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  private options: ChromeHostOptions;
  constructor(options: ChromeHostOptions) {
    this.options = options;
  }
  get running(): ChromeInstance | undefined {
    return this.instance;
  }
  async acquire(signal: AbortSignal): Promise<ChromeLease> {
    if (this.closing) throw new Error("Browser service shutting down");
    this.leases++;
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.release();
    };
    try {
      const instance = await abortable(this.ready(), signal);
      return { instance, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Stops the browser now and refuses new leases. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      this.cancelIdle?.();
      const starting = this.starting;
      if (starting) await starting.catch(() => {});
      this.retire();
      await Promise.allSettled(this.exiting);
    })();
    return this.closing;
  }
  private ready(): Promise<ChromeInstance> {
    if (this.instance && !this.instance.connection.closed) return Promise.resolve(this.instance);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start(): Promise<ChromeInstance> {
    const signal = this.lifetime.signal;
    const executable = await this.options.executable(signal);
    await Promise.allSettled(this.exiting);
    signal.throwIfAborted();
    const instance = await launchChrome({
      executable,
      profileDir: this.options.profileDir,
      stagingDir: this.options.stagingDir,
      platform: this.options.platform,
      launch: this.options.launch,
      cleanup: this.options.cleanup,
    });
    this.instance = instance;
    const exited = instance.exited.finally(() => {
      this.exiting.delete(exited);
      if (this.instance === instance) this.instance = undefined;
    });
    this.exiting.add(exited);
    if (signal.aborted) {
      await instance.stop();
      throw new Error("Browser service shutting down");
    }
    return instance;
  }
  private release(): void {
    this.leases--;
    if (this.leases > 0 || this.closing) return;
    this.cancelIdle?.();
    this.cancelIdle = this.options.cleanup.schedule(() => {
      this.cancelIdle = undefined;
      if (this.leases > 0) return;
      this.retire();
    }, this.options.launch.idleMs);
  }
  /** The next lease starts a fresh process once this one has fully exited. */
  private retire(): void {
    const instance = this.instance;
    this.instance = undefined;
    void instance?.stop();
  }
}

/** The caller stops waiting on abort; shared startup continues for other callers. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Browser launch cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Browser launch cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
