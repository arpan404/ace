import {
  AvccRecords,
  annexB,
  avcConfig,
  type AvcConfig,
  type AvccRecord,
} from "./simulator-avcc.ts";

type Subscription = {
  controller: AbortController;
  config: AvcConfig | undefined;
  /** Settles when this subscription's first IDR has been published, or it failed first. */
  keyed: PromiseWithResolvers<void>;
};

/**
 * serve-sim's H.264 passed through as-is: each access unit is re-framed as Annex B and
 * published; nothing is decoded or re-encoded. A new subscription always opens with the
 * decoder configuration and an IDR, so a keyframe request opens one, switches to it at its
 * IDR and closes the old one. The picture never stops while a keyframe is on its way.
 */
export class SimulatorH264 {
  private active: Subscription | undefined;
  private next: Subscription | undefined;
  private stopped = false;
  private readonly options: {
    url: URL;
    fetch: typeof fetch;
    after(ms: number, run: () => void): () => void;
    publish(payload: Buffer, keyframe: boolean, config: AvcConfig): void;
    failure(error: unknown): void;
  };
  constructor(options: SimulatorH264["options"]) {
    this.options = options;
  }
  /** Resolves once the first IDR has been published. */
  start(): Promise<void> {
    return this.keyframe(10000);
  }
  /** Resolves once a fresh IDR has been published. Concurrent requests share one. */
  keyframe(timeoutMs = 5000): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Simulator video stopped"));
    if (this.next) return this.next.keyed.promise;
    const subscription = this.open();
    this.next = subscription;
    const cancel = this.options.after(timeoutMs, () =>
      subscription.keyed.reject(new Error("Simulator video keyframe timed out")),
    );
    void subscription.keyed.promise.then(cancel, () => {
      cancel();
      subscription.controller.abort();
      if (this.next === subscription) this.next = undefined;
    });
    return subscription.keyed.promise;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const subscription of [this.active, this.next]) {
      subscription?.keyed.reject(new Error("Simulator video stopped"));
      subscription?.controller.abort();
    }
    this.active = this.next = undefined;
  }
  private open(): Subscription {
    const subscription: Subscription = {
      controller: new AbortController(),
      config: undefined,
      keyed: Promise.withResolvers<void>(),
    };
    void subscription.keyed.promise.catch(() => {});
    const { signal } = subscription.controller;
    const reading = (async () => {
      const response = await this.options.fetch(this.options.url, { signal, redirect: "error" });
      if (!response.ok || !response.body) throw new Error("Simulator H.264 stream unavailable");
      const records = new AvccRecords((record) => this.record(subscription, record));
      for await (const chunk of response.body) {
        if (signal.aborted) return;
        records.push(Buffer.from(chunk));
      }
      if (!signal.aborted) throw new Error("Simulator H.264 stream ended");
    })();
    void reading.catch((error: unknown) => {
      if (signal.aborted || this.stopped) return;
      subscription.keyed.reject(error);
      if (this.active === subscription) this.options.failure(error);
    });
    return subscription;
  }
  private record(subscription: Subscription, record: AvccRecord): void {
    if (this.stopped || subscription.controller.signal.aborted) return;
    if (record.kind === "description") {
      subscription.config = avcConfig(record.body);
      return;
    }
    if (record.kind === "other") return;
    const config = subscription.config;
    if (!config) throw new Error("Simulator H.264 sample arrived before its description");
    if (record.kind === "key" && this.next === subscription) {
      const previous = this.active;
      this.active = subscription;
      this.next = undefined;
      previous?.controller.abort();
    }
    // Deltas before this subscription's first IDR have nothing to decode against.
    if (this.active !== subscription) return;
    this.options.publish(
      annexB(record.body, config, record.kind === "key"),
      record.kind === "key",
      config,
    );
    if (record.kind === "key") subscription.keyed.resolve();
  }
}
