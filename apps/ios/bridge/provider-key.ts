import {
  ApiKeyUpstream,
  ProviderApiKey,
  type ClientMessage,
  type ProviderLoginProgress,
} from "@ace/protocol";
import { ManagedAccountProvider } from "@ace/protocol/accounts";
import { accountBadgePreview, providerNames } from "@ace/ui-core";
import { z } from "zod";
import { finished, KeyLink, stepMs, type KeyLinkDeps } from "./provider-key-link.ts";

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

export interface KeyHandOffDeps extends KeyLinkDeps {
  /** The phone reaches this machine through ace's relay, the only way a key may travel. */
  relayed(): boolean;
}

type Reply = { ok: true; instance: string | null } | { ok: false; problem: string };

/** Said when the phone reaches its machine directly: keys go only through ace's relay. */
export const directLinkProblem =
  "This phone reaches the computer directly, and ace takes API keys from a phone only through ace's relay. Add the key in ace on the computer, or sign in to your ace account on this phone.";
const unreachable =
  "Couldn't reach the computer to hand over the key. Check the connection and retry.";
const forbidden =
  "This device can't add accounts. Pair it with full access from Settings › Fleet on the computer running ace.";
/** How long the CLI may take to check a key. */
const checkMs = 60_000;

const cancelledProblem = "The sign-in was cancelled.";
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
    if (!deps.relayed()) return fail(directLinkProblem);
    const label = request.label.trim();
    if (!label) return fail("Give the account a name, like Work.");
    const badge = accountBadgePreview({ label, shortLabel: request.shortLabel });
    if (badge.problem) return fail(badge.problem);
    if (!ProviderApiKey.safeParse(key).success) return fail("Paste a valid API key and try again.");
    const link = new KeyLink(deps, request.provider, signal);
    let outcome: Outcome;
    try {
      outcome = await attempt(
        link,
        deps,
        request,
        { label, shortLabel: badge.save.shortLabel },
        () => {
          const taken = key;
          key = "";
          return taken;
        },
      );
    } finally {
      // Whatever happened, a sign-in this hand-off won't finish is cancelled before it closes.
      await link.finish();
    }
    if (outcome.ok || outcome.settled || signal.aborted) return outcome.reply;
    // The phone lost track of an add the daemon may have committed: the list says, so a retry
    // never adds the account twice.
    const instance = link.instance;
    if (instance && (await listed(deps, request.provider, instance))) return { ok: true, instance };
    return outcome.reply;
  } finally {
    key = "";
  }
}

/** What one try came to; `settled` when the daemon itself said how the sign-in ended. */
type Outcome = { ok: boolean; settled: boolean; reply: Reply };
const done = (reply: Reply, settled: boolean): Outcome => ({ ok: reply.ok, settled, reply });

async function attempt(
  link: KeyLink,
  deps: KeyHandOffDeps,
  request: ApiKeyScreenRequest,
  fields: { label: string; shortLabel: string | undefined },
  takeKey: () => string,
): Promise<Outcome> {
  const name = providerNames[request.provider];
  if (!(await link.ready())) return done(fail(unreachable), false);
  const added = await link.ask({
    type: "provider.accounts.add",
    requestId: deps.id(),
    provider: request.provider,
    label: fields.label,
    ...(fields.shortLabel ? { shortLabel: fields.shortLabel } : {}),
    method: "api_key",
    ...(request.upstream ? { upstream: request.upstream } : {}),
  });
  if (!added || added.type !== "provider.accounts.result") return done(fail(unreachable), false);
  // A refused add never publishes its staged account.
  if (!added.result.ok) return done(fail(addRefusal(added.result.error, name)), true);
  const started = added.result.progress;
  if (!started) return done(fail(`${name} didn't start its key sign-in. Try again.`), false);
  const session = started.session;
  link.own(started);
  const instance = link.instance ?? started.instance ?? null;
  const asking = await link.progress(session, (state) => state !== "starting", stepMs);
  if (!asking) return done(fail(`${name} didn't ask for the key. Try again.`), false);
  if (asking.state === "succeeded") return done({ ok: true, instance }, true);
  if (finished(asking.state)) return done(fail(ended(asking, name)), true);
  if (asking.state !== "awaiting_api_key")
    return done(
      fail(`${name} asked for a browser sign-in instead. Choose Sign in with the browser.`),
      false,
    );
  // The screen may have stopped waiting while the CLI got ready: then the key never goes.
  if (link.aborted) return done(fail(cancelledProblem), false);
  const message: ClientMessage = {
    type: "provider.login.apiKey",
    requestId: deps.id(),
    session,
    apiKey: takeKey(),
  };
  // The link refuses it after a cancel; the channel clears the message's key once it has gone.
  const handed = await link.ask(message);
  if (!handed || handed.type !== "provider.login.result")
    return done(fail(link.aborted ? cancelledProblem : unreachable), false);
  if (!handed.result.ok) return done(fail(keyRefusal(handed.result.error, name)), false);
  link.own(handed.result.progress);
  const end = await link.progress(session, finished, checkMs);
  if (!end)
    return done(fail(`${name} didn't finish checking the key. Check it and try again.`), false);
  return done(end.state === "succeeded" ? { ok: true, instance } : fail(ended(end, name)), true);
}

/** The account is on the provider's list: its add committed. */
async function listed(deps: KeyHandOffDeps, provider: ApiKeyScreenRequest["provider"], id: string) {
  try {
    const reply = await deps.owner.request(
      { type: "provider.accounts.list", provider },
      { timeoutMs: stepMs },
    );
    return reply.result.ok && reply.result.accounts.some((account) => account.id === id);
  } catch {
    return false;
  }
}

function ended(progress: ProviderLoginProgress, name: string): string {
  if (progress.state === "cancelled") return cancelledProblem;
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
