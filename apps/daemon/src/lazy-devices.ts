import type { Actor, DevicesService } from "@ace/devices";

/**
 * The devices service, built on first use. Devices stay off until a person turns them on in the
 * Devices page, so until something asks for them (that page, `ace sim`, an agent's sim_* tool,
 * a phone's devices channel) the daemon holds none of their code.
 */
export class LazyDevices {
  readonly #build: () => Promise<DevicesService>;
  #service: DevicesService | undefined;
  #loading: Promise<DevicesService> | undefined;
  #closed = false;
  readonly #enabledWatchers = new Map<(enabled: boolean) => void, (() => void) | undefined>();
  readonly #loadWatchers = new Set<(service: DevicesService) => void>();
  constructor(build: () => Promise<DevicesService>) {
    this.#build = build;
  }
  /** A service that already exists, for hosts that inject their own. */
  static of(service: DevicesService): LazyDevices {
    const devices = new LazyDevices(async () => service);
    devices.#adopt(service);
    return devices;
  }
  #adopt(service: DevicesService): void {
    this.#service = service;
    for (const listener of this.#enabledWatchers.keys())
      this.#enabledWatchers.set(listener, service.watchEnabled(listener));
    for (const listener of this.#loadWatchers) listener(service);
  }
  /** The service once something has loaded it. */
  current(): DevicesService | undefined {
    return this.#service;
  }
  load(): Promise<DevicesService> {
    if (this.#service) return Promise.resolve(this.#service);
    if (this.#closed) return Promise.reject(new Error("Devices are closed"));
    this.#loading ??= this.#build().then(
      async (service) => {
        if (this.#closed) {
          await service.close();
          throw new Error("Devices are closed");
        }
        this.#adopt(service);
        return service;
      },
      (error: unknown) => {
        this.#loading = undefined;
        throw error;
      },
    );
    return this.#loading;
  }
  /** Off until loaded: a person turns devices on through a request, which loads them. */
  isEnabled(): boolean {
    return this.#service?.isEnabled() ?? false;
  }
  watchEnabled(listener: (enabled: boolean) => void): () => void {
    this.#enabledWatchers.set(listener, this.#service?.watchEnabled(listener));
    return () => {
      this.#enabledWatchers.get(listener)?.();
      this.#enabledWatchers.delete(listener);
    };
  }
  /** Runs once the service exists: now, when it already does. */
  whenLoaded(listener: (service: DevicesService) => void): () => void {
    if (this.#service) {
      listener(this.#service);
      return () => {};
    }
    this.#loadWatchers.add(listener);
    return () => this.#loadWatchers.delete(listener);
  }
  /** A request is someone using devices, so it loads them. */
  async request(
    operation: Parameters<DevicesService["request"]>[0],
    actor: Actor,
  ): Promise<unknown> {
    return (await this.load()).request(operation, actor);
  }
  disconnect(owner: string): void {
    this.#service?.disconnect(owner);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#loadWatchers.clear();
    await this.#loading?.catch(() => {});
    await this.#service?.close();
  }
}

const wrapped = new WeakMap<DevicesService, LazyDevices>();
/** Hosts and tests may hand a ready service; sessions always see the lazy handle. */
export function lazyDevices(devices: DevicesService | LazyDevices): LazyDevices {
  if (devices instanceof LazyDevices) return devices;
  let lazy = wrapped.get(devices);
  if (!lazy) {
    lazy = LazyDevices.of(devices);
    wrapped.set(devices, lazy);
  }
  return lazy;
}
