import type { ClientCore } from "@ace/client";
import type { authenticatedChannel } from "@ace/client/devices";
import type { ClientMessage, ProviderLoginProgress, ServerMessage } from "@ace/protocol";

/*
 * One `provider_auth` channel for one API-key hand-off (`provider-key.ts`): requests answered by
 * `requestId`, the newest progress of each sign-in, and the sign-in the hand-off owns. It owns
 * the key sign-in that any frame names first (a push can come before the reply that started
 * it), and `finish` cancels that sign-in unless it ended: over this channel while it's open,
 * else over the main socket. A stopped screen ends the waits for progress and refuses new
 * requests, but a request already sent still gets its answer and the channel stays for
 * `finish`, so the cancel can name the sign-in and still go.
 */

export type AuthenticatedChannel = ReturnType<typeof authenticatedChannel>;

export interface KeyLinkDeps {
  channel(): AuthenticatedChannel;
  /** The main client: the cancel's way when the channel is gone. */
  owner: Pick<ClientCore, "request">;
  id(): string;
  schedule(delayMs: number, callback: () => void): () => void;
}

type State = ProviderLoginProgress["state"];
type Waiter = { done(frame: ServerMessage | undefined): void };
type Watch = {
  session: string;
  until(state: State): boolean;
  done(progress?: ProviderLoginProgress): void;
};

/** How long one request may wait for its answer. */
export const stepMs = 20_000;

export const finished = (state: State) =>
  state === "succeeded" || state === "failed" || state === "cancelled";

export class KeyLink {
  readonly #deps: KeyLinkDeps;
  readonly #provider: ProviderLoginProgress["provider"];
  readonly #signal: AbortSignal;
  readonly #channel: AuthenticatedChannel;
  readonly #answers = new Map<string, Waiter>();
  readonly #watches = new Set<Watch>();
  readonly #latest = new Map<string, ProviderLoginProgress>();
  readonly #opened: Promise<boolean>;
  #closed = false;
  #stopAbort: () => void;
  /** The key sign-in this hand-off started; cleared once it ends. */
  #session: string | undefined;
  /** The account that sign-in adds, once a frame names it. */
  #instance: string | undefined;

  constructor(deps: KeyLinkDeps, provider: ProviderLoginProgress["provider"], signal: AbortSignal) {
    this.#deps = deps;
    this.#provider = provider;
    this.#signal = signal;
    this.#channel = deps.channel();
    // A request already sent still gets its answer, which names the sign-in `finish` cancels.
    const onAbort = () => {
      for (const watch of this.#watches) watch.done();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#stopAbort = () => signal.removeEventListener("abort", onAbort);
    this.#opened = new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      this.#channel.open({
        ready: () => resolve(true),
        message: (frame) => {
          if (!(frame instanceof Uint8Array)) this.#receive(frame);
        },
        close: () => {
          resolve(false);
          this.#closed = true;
          this.#wake();
        },
      });
    });
  }

  ready(): Promise<boolean> {
    return this.#opened;
  }

  /** The screen stopped waiting. */
  get aborted(): boolean {
    return this.#signal.aborted;
  }

  /** The account the owned sign-in adds, once any frame has named it. */
  get instance(): string | undefined {
    return this.#instance;
  }

  /** Send one request and wait for its answer; undefined once the channel or screen is gone. */
  ask(message: ClientMessage): Promise<ServerMessage | undefined> {
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (this.#closed || this.#signal.aborted || !requestId) {
      if (message.type === "provider.login.apiKey") message.apiKey = "";
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const stop = this.#deps.schedule(stepMs, () => settle(undefined));
      const settle = (frame: ServerMessage | undefined) => {
        stop();
        this.#answers.delete(requestId);
        resolve(frame);
      };
      this.#answers.set(requestId, { done: settle });
      this.#channel.send(message).catch(() => settle(undefined));
    });
  }

  /** A snapshot from a reply, ordered with the pushes; the hand-off owns the sign-in it names. */
  own(progress: ProviderLoginProgress): void {
    if (!this.#session && !this.#instance && !finished(progress.state)) {
      this.#session = progress.session;
      this.#instance = progress.instance;
    }
    if (progress.session === this.#session) this.#instance ??= progress.instance;
    this.#seen(progress);
  }

  /** The session's first snapshot that `until` accepts, or undefined after `ms` or a close. */
  progress(
    session: string,
    until: (state: State) => boolean,
    ms: number,
  ): Promise<ProviderLoginProgress | undefined> {
    const known = this.#latest.get(session);
    if (known && until(known.state)) return Promise.resolve(known);
    if (this.#closed || this.#signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const watch: Watch = {
        session,
        until,
        done: (progress) => {
          stop();
          this.#watches.delete(watch);
          resolve(progress);
        },
      };
      const stop = this.#deps.schedule(ms, () => watch.done());
      this.#watches.add(watch);
    });
  }

  /** Cancel the owned sign-in unless it ended, so its staged account goes too; then close. */
  async finish(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    this.#stopAbort();
    if (session) {
      const cancel = {
        type: "provider.login.cancel" as const,
        requestId: this.#deps.id(),
        session,
      };
      try {
        if (!this.#closed) await this.#channel.send(cancel);
        else await this.#deps.owner.request(cancel, { timeoutMs: stepMs });
      } catch {
        // Unreachable either way: the daemon's own expiry removes a sign-in no key reached.
      }
    }
    this.#closed = true;
    this.#wake();
    this.#channel.close();
  }

  #wake(): void {
    for (const waiter of this.#answers.values()) waiter.done(undefined);
    for (const watch of this.#watches) watch.done();
  }

  #seen(progress: ProviderLoginProgress): void {
    const known = this.#latest.get(progress.session);
    if (known && known.sequence >= progress.sequence) return;
    this.#latest.set(progress.session, progress);
    if (progress.session === this.#session && finished(progress.state)) this.#session = undefined;
    for (const watch of this.#watches)
      if (watch.session === progress.session && watch.until(progress.state)) watch.done(progress);
  }

  #receive(frame: ServerMessage): void {
    if (frame.type === "provider.login.progress") {
      const progress = frame.progress;
      // Only this device's sign-ins come here; the first unfinished key login for the provider
      // is the one this hand-off's add started, even when its push beats the reply.
      if (
        progress.provider === this.#provider &&
        progress.action === "login" &&
        progress.method === "api_key"
      )
        this.own(progress);
      else this.#seen(progress);
      return;
    }
    // An answer that names a key sign-in makes it this hand-off's, even with no one waiting.
    if (
      (frame.type === "provider.accounts.result" || frame.type === "provider.login.result") &&
      frame.result.ok &&
      frame.result.progress?.method === "api_key" &&
      frame.result.progress.provider === this.#provider
    )
      this.own(frame.result.progress);
    if ("requestId" in frame && typeof frame.requestId === "string")
      this.#answers.get(frame.requestId)?.done(frame);
  }
}
