import type { authenticatedChannel } from "@ace/client/devices";
import {
  ApiKeyUpstream,
  ProviderApiKey,
  type ClientMessage,
  type ProviderLoginProgress,
  type ServerMessage,
} from "@ace/protocol";
import { ManagedAccountProvider } from "@ace/protocol/accounts";
import { accountBadgePreview, providerNames } from "@ace/ui-core";
import { z } from "zod";

/*
 * Adding a provider account on the phone with a pasted API key (ADR 0002, 2026-10-07 amendment).
 * The key goes to the daemon only on its own encrypted `provider_auth` relay channel, opened for
 * this one hand-off and closed after it: `provider.accounts.add` with `method: api_key`, the
 * CLI's `awaiting_api_key`, then `provider.login.apiKey`, then the sign-in's end. The key is held
 * in this call only; nothing here logs it, keeps it, or puts it in an answer. A phone that
 * reaches its machine directly can't hand one over (the daemon refuses keys on an ordinary
 * paired socket), so it is told so before anything is opened. Every failure is said in fixed
 * words.
 */

type AuthenticatedChannel = ReturnType<typeof authenticatedChannel>;

export const ApiKeyScreenRequest = z.object({
  type: z.literal("accounts.screen.key"),
  provider: ManagedAccountProvider,
  label: z.string().max(256),
  shortLabel: z.string().max(64).default(""),
  upstream: ApiKeyUpstream.optional(),
  /** Bounded above the protocol's own limit so a too-long paste is refused in words, not dropped. */
  apiKey: z.string().max(16_384),
});
export type ApiKeyScreenRequest = z.infer<typeof ApiKeyScreenRequest>;

export interface KeyHandOffDeps {
  /** A new `provider_auth` channel to this machine; opened and closed by each hand-off. */
  channel(): AuthenticatedChannel;
  /** The phone reaches this machine through ace's relay, the only way a key may travel. */
  relayed(): boolean;
  id(): string;
  schedule(delayMs: number, callback: () => void): () => void;
}

type Reply = { ok: true; instance: string | null } | { ok: false; problem: string };

/** Said when the phone reaches its machine directly: keys go only through ace's relay. */
export const directLinkProblem =
  "This phone reaches the computer directly, and ace takes API keys from a phone only through ace's relay. Add the key in ace on the computer, or sign in to your ace account on this phone.";
const unreachable =
  "Couldn't reach the computer to hand over the key. Check the connection and retry.";
const forbidden =
  "This device can't add accounts. Pair it with full access from Settings › Fleet on the computer running ace.";
/** How long each step may take: opening the channel, the CLI asking, the CLI checking. */
const stepMs = 20_000;
const checkMs = 60_000;

const fail = (problem: string): Reply => ({ ok: false, problem });

/** Hand one pasted key to the CLI of a new account. The caller's copy of the key is cleared. */
export async function handOverApiKey(
  deps: KeyHandOffDeps,
  request: ApiKeyScreenRequest,
  signal: AbortSignal,
): Promise<Reply> {
  let key = request.apiKey.trim();
  request.apiKey = "";
  try {
    const name = providerNames[request.provider];
    if (!deps.relayed()) return fail(directLinkProblem);
    const label = request.label.trim();
    if (!label) return fail("Give the account a name, like Work.");
    const badge = accountBadgePreview({ label, shortLabel: request.shortLabel });
    if (badge.problem) return fail(badge.problem);
    if (!ProviderApiKey.safeParse(key).success) return fail("Paste a valid API key and try again.");
    const link = new KeyLink(deps, signal);
    try {
      if (!(await link.ready())) return fail(unreachable);
      const added = await link.ask({
        type: "provider.accounts.add",
        requestId: deps.id(),
        provider: request.provider,
        label,
        ...(badge.save.shortLabel ? { shortLabel: badge.save.shortLabel } : {}),
        method: "api_key",
        ...(request.upstream ? { upstream: request.upstream } : {}),
      });
      if (!added || added.type !== "provider.accounts.result") return fail(unreachable);
      if (!added.result.ok) return fail(addRefusal(added.result.error, name));
      const started = added.result.progress;
      if (!started) return fail(`${name} didn't start its key sign-in. Try again.`);
      const session = started.session;
      const instance = started.instance ?? null;
      link.own(started);
      const asking = await link.progress(session, (state) => state !== "starting", stepMs);
      if (!asking) {
        await link.cancel(session);
        return fail(`${name} didn't ask for the key. Try again.`);
      }
      if (asking.state !== "awaiting_api_key") {
        if (!finished(asking.state)) await link.cancel(session);
        return asking.state === "succeeded"
          ? { ok: true, instance }
          : fail(
              finished(asking.state)
                ? ended(asking, name)
                : `${name} asked for a browser sign-in instead. Choose Sign in with the browser.`,
            );
      }
      const message: ClientMessage = {
        type: "provider.login.apiKey",
        requestId: deps.id(),
        session,
        apiKey: key,
      };
      key = "";
      // The channel clears the message's key once it has gone.
      const handed = await link.ask(message);
      if (!handed || handed.type !== "provider.login.result") {
        await link.cancel(session);
        return fail(unreachable);
      }
      if (!handed.result.ok) {
        await link.cancel(session);
        return fail(keyRefusal(handed.result.error, name));
      }
      link.seen(handed.result.progress);
      const done = await link.progress(session, finished, checkMs);
      if (!done)
        return fail(
          `${name} didn't finish checking the key. Pull to refresh to see whether the account was added.`,
        );
      return done.state === "succeeded" ? { ok: true, instance } : fail(ended(done, name));
    } finally {
      link.close();
    }
  } finally {
    key = "";
  }
}

const finished = (state: ProviderLoginProgress["state"]) =>
  state === "succeeded" || state === "failed" || state === "cancelled";

function ended(progress: ProviderLoginProgress, name: string): string {
  if (progress.state === "cancelled") return "The sign-in was cancelled.";
  // The daemon's own words on a failed sign-in are fixed categories, never the CLI's output.
  return progress.message ?? `${name} didn't take that key. Check it and try again.`;
}

function addRefusal(error: string, name: string): string {
  if (error === "forbidden") return forbidden;
  if (error === "busy") return "Another sign-in is running. Finish it, then try again.";
  if (error === "unsupported") return `${name} can't take an API key from ace.`;
  return `Couldn't start ${name}'s key sign-in. Try again.`;
}

function keyRefusal(error: string, name: string): string {
  // On a direct socket the daemon turns keys down as forbidden, whatever the device's scope.
  if (error === "forbidden") return directLinkProblem;
  if (error === "not_found") return "That sign-in has ended. Try again.";
  if (error === "busy") return "Another sign-in is running. Finish it, then try again.";
  if (error === "invalid_input") return `${name} wasn't waiting for a key any more. Try again.`;
  return `ace couldn't hand the key to ${name}. Try again.`;
}

type Waiter = { done(frame: ServerMessage | undefined): void };
type Watch = {
  session: string;
  until(state: ProviderLoginProgress["state"]): boolean;
  done(progress: ProviderLoginProgress | undefined): void;
};

/**
 * One `provider_auth` channel for one hand-off: requests answered by `requestId`, and the
 * newest progress of each session (pushes can come before the reply that started it).
 */
class KeyLink {
  readonly #deps: KeyHandOffDeps;
  readonly #signal: AbortSignal;
  readonly #channel: AuthenticatedChannel;
  readonly #answers = new Map<string, Waiter>();
  readonly #watches = new Set<Watch>();
  readonly #latest = new Map<string, ProviderLoginProgress>();
  #opened: Promise<boolean>;
  #closed = false;
  /** The sign-in this hand-off started and hasn't seen end. */
  #session: string | undefined;
  #stopAbort: () => void;

  constructor(deps: KeyHandOffDeps, signal: AbortSignal) {
    this.#deps = deps;
    this.#signal = signal;
    this.#channel = deps.channel();
    // A screen that stops waiting leaves no sign-in behind: its session is cancelled first.
    const onAbort = () => {
      const session = this.#session;
      if (!session || this.#closed) {
        this.close();
        return;
      }
      void this.#channel
        .send({ type: "provider.login.cancel", requestId: deps.id(), session })
        .catch(() => {})
        .finally(() => this.close());
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
          this.#end();
        },
      });
    });
  }

  ready(): Promise<boolean> {
    return this.#opened;
  }

  /** Send one request and wait for its answer, or undefined when the channel can't give one. */
  ask(message: ClientMessage): Promise<ServerMessage | undefined> {
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (this.#closed || !requestId) {
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

  /** The sign-in this hand-off started: cancelled if the screen stops waiting for it. */
  own(progress: ProviderLoginProgress): void {
    this.#session = progress.session;
    this.seen(progress);
  }

  /** A progress snapshot the phone has from a reply; pushes and replies share one order. */
  seen(progress: ProviderLoginProgress): void {
    const known = this.#latest.get(progress.session);
    if (known && known.sequence >= progress.sequence) return;
    this.#latest.set(progress.session, progress);
    if (progress.session === this.#session && finished(progress.state)) this.#session = undefined;
    for (const watch of this.#watches)
      if (watch.session === progress.session && watch.until(progress.state)) watch.done(progress);
  }

  /** The session's first snapshot that `until` accepts, or undefined after `ms` or a close. */
  progress(
    session: string,
    until: (state: ProviderLoginProgress["state"]) => boolean,
    ms: number,
  ): Promise<ProviderLoginProgress | undefined> {
    const known = this.#latest.get(session);
    if (known && until(known.state)) return Promise.resolve(known);
    if (this.#closed) return Promise.resolve(undefined);
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
      const stop = this.#deps.schedule(ms, () => watch.done(undefined));
      this.#watches.add(watch);
    });
  }

  /** Stop a sign-in this hand-off won't finish, so its staged account goes too. */
  async cancel(session: string): Promise<void> {
    if (this.#signal.aborted) return;
    await this.ask({ type: "provider.login.cancel", requestId: this.#deps.id(), session });
  }

  close(): void {
    if (this.#closed) return;
    this.#channel.close();
    this.#end();
  }

  #end(): void {
    this.#closed = true;
    this.#stopAbort();
    for (const waiter of this.#answers.values()) waiter.done(undefined);
    for (const watch of this.#watches) watch.done(undefined);
  }

  #receive(frame: ServerMessage): void {
    if (frame.type === "provider.login.progress") {
      this.seen(frame.progress);
      return;
    }
    if ("requestId" in frame && typeof frame.requestId === "string")
      this.#answers.get(frame.requestId)?.done(frame);
  }
}
