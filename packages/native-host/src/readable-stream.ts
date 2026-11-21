/*
 * A `ReadableStream` for a bare JS engine (JavaScriptCore has none): the default-reader subset
 * the shared client uses, with a queuing strategy and pull-based backpressure. Byte streams,
 * BYOB readers, tee and piping are not here. Passed to what needs it (the machine tunnel's
 * `ReadableStream` option), never installed globally.
 */

interface Source<T> {
  start?(controller: Controller<T>): unknown;
  pull?(controller: Controller<T>): unknown;
  cancel?(reason?: unknown): unknown;
}
interface Strategy<T> {
  highWaterMark?: number;
  size?(chunk: T): number;
}
interface Controller<T> {
  enqueue(chunk: T): void;
  close(): void;
  error(reason?: unknown): void;
  readonly desiredSize: number | null;
}
type Result<T> = { done: false; value: T } | { done: true; value: undefined };
interface Request<T> {
  resolve(result: Result<T>): void;
  reject(reason: unknown): void;
}

export class PortableReadableStream<T> {
  #queue: { chunk: T; size: number }[] = [];
  #queued = 0;
  #state: "readable" | "closed" | "errored" = "readable";
  #reason: unknown;
  #closeRequested = false;
  #started = false;
  #pulling = false;
  #pullAgain = false;
  #requests: Request<T>[] = [];
  #locked = false;
  readonly #source: Source<T>;
  readonly #highWaterMark: number;
  readonly #size: (chunk: T) => number;

  constructor(source: Source<T> = {}, strategy: Strategy<T> = {}) {
    this.#source = source;
    this.#highWaterMark = strategy.highWaterMark ?? 1;
    this.#size = strategy.size ?? (() => 1);
    const desiredSize = () => this.#desiredSize();
    const controller: Controller<T> = {
      enqueue: (chunk) => this.#enqueue(chunk),
      close: () => this.#close(),
      error: (reason) => this.#error(reason),
      get desiredSize() {
        return desiredSize();
      },
    };
    Promise.resolve(source.start?.(controller)).then(
      () => {
        this.#started = true;
        this.#pullIfWanted(controller);
      },
      (reason: unknown) => this.#error(reason),
    );
    this.#controller = controller;
  }
  readonly #controller: Controller<T>;

  get locked(): boolean {
    return this.#locked;
  }

  getReader() {
    if (this.#locked) throw new TypeError("The stream is locked to a reader");
    this.#locked = true;
    let released = false;
    const check = () => {
      if (released) throw new TypeError("The reader was released");
    };
    return {
      read: (): Promise<Result<T>> => {
        if (released) return Promise.reject(new TypeError("The reader was released"));
        return this.#read();
      },
      releaseLock: () => {
        if (released) return;
        released = true;
        this.#locked = false;
        const error = new TypeError("The reader was released");
        for (const request of this.#requests.splice(0)) request.reject(error);
      },
      cancel: (reason?: unknown): Promise<void> => {
        check();
        return this.cancel(reason);
      },
    };
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.#state === "errored") return Promise.reject(this.#reason);
    if (this.#state === "closed") return Promise.resolve();
    this.#finishClosed();
    this.#queue = [];
    this.#queued = 0;
    return Promise.resolve(this.#source.cancel?.(reason)).then(() => undefined);
  }

  #read(): Promise<Result<T>> {
    if (this.#state === "errored") return Promise.reject(this.#reason);
    const head = this.#queue.shift();
    if (head) {
      this.#queued -= head.size;
      if (this.#closeRequested && this.#queue.length === 0) this.#finishClosed();
      else this.#pullIfWanted(this.#controller);
      return Promise.resolve({ done: false, value: head.chunk });
    }
    if (this.#state === "closed") return Promise.resolve({ done: true, value: undefined });
    const { promise, resolve, reject } = Promise.withResolvers<Result<T>>();
    this.#requests.push({ resolve, reject });
    this.#pullIfWanted(this.#controller);
    return promise;
  }

  #desiredSize(): number | null {
    if (this.#state === "errored") return null;
    if (this.#state === "closed") return 0;
    return this.#highWaterMark - this.#queued;
  }

  #enqueue(chunk: T): void {
    if (this.#state !== "readable" || this.#closeRequested)
      throw new TypeError("The stream is closed or errored");
    const waiting = this.#requests.shift();
    if (waiting) waiting.resolve({ done: false, value: chunk });
    else {
      const size = this.#size(chunk);
      this.#queue.push({ chunk, size });
      this.#queued += size;
    }
    this.#pullIfWanted(this.#controller);
  }

  #close(): void {
    if (this.#state !== "readable" || this.#closeRequested)
      throw new TypeError("The stream is closed or errored");
    this.#closeRequested = true;
    if (this.#queue.length === 0) this.#finishClosed();
  }

  #finishClosed(): void {
    this.#state = "closed";
    for (const request of this.#requests.splice(0))
      request.resolve({ done: true, value: undefined });
  }

  #error(reason: unknown): void {
    if (this.#state !== "readable") return;
    this.#state = "errored";
    this.#reason = reason;
    this.#queue = [];
    this.#queued = 0;
    for (const request of this.#requests.splice(0)) request.reject(reason);
  }

  #pullIfWanted(controller: Controller<T>): void {
    if (!this.#started || this.#state !== "readable" || this.#closeRequested) return;
    const wanted = this.#requests.length > 0 || (this.#desiredSize() ?? 0) > 0;
    if (!wanted) return;
    if (this.#pulling) {
      this.#pullAgain = true;
      return;
    }
    if (!this.#source.pull) return;
    this.#pulling = true;
    Promise.resolve(this.#source.pull(controller)).then(
      () => {
        this.#pulling = false;
        if (this.#pullAgain) {
          this.#pullAgain = false;
          this.#pullIfWanted(controller);
        }
      },
      (reason: unknown) => this.#error(reason),
    );
  }
}

/** The class, typed as the platform's, for options that take `typeof ReadableStream`. */
export const portableReadableStream = PortableReadableStream as unknown as typeof ReadableStream;
