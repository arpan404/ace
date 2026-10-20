export type LatestFrameSink<T> = (frame: T) => Promise<void>;
type Subscriber<T> = {
  send: LatestFrameSink<T>;
  busy: boolean;
  pending: T | undefined;
  active: boolean;
};
/** One in-flight item and one replaceable pending item per consumer, no history. */
export class LatestFrameHub<T> {
  private readonly subscribers = new Set<Subscriber<T>>();
  subscribe(send: LatestFrameSink<T>, initial?: T): () => void {
    if (this.subscribers.size >= 64) throw new Error("Subscriber limit");
    const subscriber: Subscriber<T> = { send, busy: false, active: true, pending: undefined };
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
  subscribeEvery(send: (frame: T) => void, initial?: T): () => void {
    if (this.every.size >= 64) throw new Error("Subscriber limit");
    let active = true;
    const listener = (frame: T) => {
      if (!active) return;
      try {
        send(frame);
      } catch {
        active = false;
        this.every.delete(listener);
      }
    };
    this.every.add(listener);
    if (initial !== undefined) listener(initial);
    return () => {
      active = false;
      this.every.delete(listener);
    };
  }
  private readonly every = new Set<(frame: T) => void>();
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
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      subscriber.pending = undefined;
    }
    this.subscribers.clear();
    this.every.clear();
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
          subscriber.active = false;
          subscriber.pending = undefined;
          this.subscribers.delete(subscriber);
        },
      );
  }
}
