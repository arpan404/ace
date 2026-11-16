export type LatestFrameSink<T> = (frame: T) => Promise<void>;
type Subscriber<T> = {
  send: LatestFrameSink<T>;
  busy: boolean;
  pending: T | undefined;
  active: boolean;
  ended: (() => void) | undefined;
};
/**
 * One in-flight item and one replaceable pending item per consumer, no history. A consumer the
 * hub drops itself (its sink threw, or the hub was cleared) hears it through `ended`, so whatever
 * it holds is released as when it unsubscribes.
 */
export class LatestFrameHub<T> {
  private readonly subscribers = new Set<Subscriber<T>>();
  subscribe(send: LatestFrameSink<T>, initial?: T, ended?: () => void): () => void {
    if (this.subscribers.size >= 64) throw new Error("Subscriber limit");
    const subscriber: Subscriber<T> = {
      send,
      busy: false,
      active: true,
      pending: undefined,
      ended,
    };
    this.subscribers.add(subscriber);
    if (initial !== undefined) this.deliver(subscriber, initial);
    return () => {
      subscriber.active = false;
      subscriber.pending = undefined;
      this.subscribers.delete(subscriber);
    };
  }
  /**
   * Every frame, in order, handed over as it is published: for a consumer that paces itself
   * (the shared media stream's ack window) and so must not lose a frame to this hub's
   * coalescing. A listener that throws is removed.
   */
  subscribeEvery(send: (frame: T) => void, initial?: T, ended?: () => void): () => void {
    if (this.every.size >= 64) throw new Error("Subscriber limit");
    let active = true;
    const drop = () => {
      if (!active) return;
      active = false;
      this.every.delete(listener);
      this.ends.delete(drop);
      ended?.();
    };
    const listener = (frame: T) => {
      if (!active) return;
      try {
        send(frame);
      } catch {
        drop();
      }
    };
    this.every.add(listener);
    this.ends.add(drop);
    if (initial !== undefined) listener(initial);
    return () => {
      active = false;
      this.every.delete(listener);
      this.ends.delete(drop);
    };
  }
  private readonly every = new Set<(frame: T) => void>();
  /** How each `subscribeEvery` listener is dropped by the hub, telling its owner. */
  private readonly ends = new Set<() => void>();
  publish(frame: T): void {
    // A listener that throws leaves the set; deleting while iterating a Set is safe.
    for (const listener of this.every) listener(frame);
    for (const subscriber of this.subscribers) {
      if (subscriber.busy) subscriber.pending = frame;
      else this.deliver(subscriber, frame);
    }
  }
  /** Invalidate queued frames without removing the mounted consumers. */
  discardPending(): void {
    for (const subscriber of this.subscribers) subscriber.pending = undefined;
  }
  clear(): void {
    const dropped = [...this.subscribers];
    for (const subscriber of dropped) {
      subscriber.active = false;
      subscriber.pending = undefined;
    }
    this.subscribers.clear();
    const ends = [...this.ends];
    this.every.clear();
    this.ends.clear();
    for (const subscriber of dropped) subscriber.ended?.();
    for (const end of ends) end();
  }
  private deliver(subscriber: Subscriber<T>, frame: T): void {
    subscriber.busy = true;
    void Promise.resolve()
      .then(() => (subscriber.active ? subscriber.send(frame) : undefined))
      .then(
        () => {
          subscriber.busy = false;
          const pending = subscriber.pending;
          subscriber.pending = undefined;
          if (subscriber.active && pending !== undefined) this.deliver(subscriber, pending);
        },
        () => {
          const was = subscriber.active;
          subscriber.active = false;
          subscriber.pending = undefined;
          this.subscribers.delete(subscriber);
          if (was) subscriber.ended?.();
        },
      );
  }
}
