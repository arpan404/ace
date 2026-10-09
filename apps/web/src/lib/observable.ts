type Listener = () => void;

/** A tiny observable value, read through `useSyncExternalStore`. */
export class Observable<T> {
  private listeners = new Set<Listener>();
  private value: T;
  constructor(value: T) {
    this.value = value;
  }
  get = (): T => this.value;
  /** Set without telling anyone: for a value loaded lazily during a render. */
  seed(value: T): void {
    this.value = value;
  }
  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
