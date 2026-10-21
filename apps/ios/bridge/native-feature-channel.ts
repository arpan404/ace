import type { Credential } from "@ace/client";
import { authenticatedChannel, ephemeralRelayKeys } from "@ace/client/devices";
import type { TrustMonitor } from "./access.ts";
import { scheduler } from "./host.ts";
import { nativePortableSocket } from "./socket.ts";

export interface NativeFeatureConfig {
  deviceId: string;
  hostId: string;
  credential(): Promise<Credential>;
  id(): string;
  trust: TrustMonitor;
}
export function nativeFeatureChannel(config: NativeFeatureConfig, feature: "devices" | "screen") {
  return authenticatedChannel(
    {
      // Swift binds sockets to the runtime's pinned machine; caller URLs never leave JavaScript.
      target: { kind: "local", url: "wss://native.invalid" },
      expectedHostId: config.hostId,
      deviceId: config.deviceId,
      credential: config.credential,
      socket: () => nativePortableSocket(config.trust),
      keys: ephemeralRelayKeys,
      schedule: (callback, delay) => scheduler.set(delay, callback),
    },
    feature,
  );
}

const noop = () => {};
interface ConnectionState {
  connected: boolean;
  error?: Error | undefined;
}
interface NativeFeatureOwner {
  state(): ConnectionState;
  begin(): void;
  watch(listener: (snapshot: ConnectionState) => void): () => void;
  end(): void;
}
/** One coalesced, bounded open. Closing rejects its waiters before releasing the SDK client. */
export class NativeFeatureConnection {
  #pending: Promise<void> | undefined;
  #cancel: (() => void) | undefined;
  readonly owner: NativeFeatureOwner;
  constructor(owner: NativeFeatureOwner) {
    this.owner = owner;
  }
  async ready(signal: AbortSignal): Promise<void> {
    if (!this.owner.state().connected) {
      this.#pending ??= this.#open().finally(() => {
        this.#pending = undefined;
      });
      await this.#pending;
    }
    signal.throwIfAborted();
  }
  close(): void {
    this.#cancel?.();
    this.owner.end();
  }
  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop = noop,
        settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cancel();
        stop();
        this.#cancel = undefined;
        if (error) reject(error);
        else resolve();
      };
      const cancel = scheduler.set(20_000, () => {
        finish(new Error("Disconnected. Check the machine connection and retry."));
        this.owner.end();
      });
      this.#cancel = () => finish(new Error("View closed"));
      this.owner.begin();
      stop = this.owner.watch((state) => {
        if (state.connected) finish();
        else if (state.error) finish(state.error);
      });
      if (settled) stop();
    });
  }
}
