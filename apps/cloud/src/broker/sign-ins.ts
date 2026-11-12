import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64url } from "@ace/account-grant";

/**
 * One account's sign-ins in progress, each living at most ten minutes: the OAuth `state`, the
 * app, Spade's PKCE challenge and one-time public key, and the authorization code from the time
 * the maker redirects back until Spade collects it. No token is ever kept here. Pure: callers
 * pass the time and get the next book back; the account's Durable Object stores it.
 */

export const SIGN_IN_SECONDS = 600;
export const SIGN_IN_MS = SIGN_IN_SECONDS * 1000;
/** Most sign-ins in progress per account; a newer one drops the oldest. */
export const MOST_PER_ACCOUNT = 5;

export type Outcome = { kind: "waiting" } | { kind: "code"; code: string } | { kind: "declined" };

export type SignIn = {
  /** What Spade names it by. */
  handle: string;
  /** The OAuth `state`, which only the maker and the person's browser see. */
  state: string;
  account: string;
  app: string;
  challenge: string;
  publicKey: string;
  startedMs: number;
  outcome: Outcome;
};

export type Book = readonly SignIn[];

/** What the maker's redirect did. */
export type CallbackVerdict =
  | { kind: "accepted"; account: string; app: string }
  /** The person declined, or the answer named another issuer: Spade is told it was declined. */
  | { kind: "declined"; account: string; app: string }
  /** No such state, another app's callback path, or it already came back once. */
  | { kind: "unknown" }
  | { kind: "expired" };

/** What Spade's finish found. */
export type FinishVerdict =
  /** The code and the key to seal the tokens to; the sign-in is gone. */
  | { kind: "ready"; code: string; publicKey: string }
  | { kind: "waiting" }
  /** No sign-in by that handle for this account and app. */
  | { kind: "unknown" }
  | { kind: "expired" }
  /** The verifier doesn't match; the sign-in is gone. */
  | { kind: "wrong_verifier" }
  /** The person declined; the sign-in is gone. */
  | { kind: "declined" };

const expired = (signIn: SignIn, now: number) => now - signIn.startedMs >= SIGN_IN_MS;
const without = (book: Book, handle: string) => book.filter((each) => each.handle !== handle);

/** Keeps a new sign-in, after dropping expired ones and, past the cap, the oldest. */
export function begin(book: Book, signIn: SignIn, now: number): Book {
  const live = book
    .filter((each) => !expired(each, now))
    .toSorted((a, b) => a.startedMs - b.startedMs);
  return [...live.slice(Math.max(0, live.length - (MOST_PER_ACCOUNT - 1))), signIn];
}

/** The app a sign-in in progress is for, by its `state`. */
export function appOf(book: Book, state: string): string | undefined {
  return book.find((each) => each.state === state)?.app;
}

/** The maker redirected back to `app`'s callback with `state`; `issuerOk` is RFC 9207's check. */
export function callback(
  book: Book,
  input: {
    state: string;
    app: string;
    code: string | undefined;
    declined: boolean;
    issuerOk: boolean;
  },
  now: number,
): { book: Book; verdict: CallbackVerdict } {
  const signIn = book.find((each) => each.state === input.state);
  if (!signIn || signIn.app !== input.app) return { book, verdict: { kind: "unknown" } };
  if (expired(signIn, now))
    return { book: without(book, signIn.handle), verdict: { kind: "expired" } };
  // A second answer for one state is a replay; the first stands.
  if (signIn.outcome.kind !== "waiting") return { book, verdict: { kind: "unknown" } };
  const { account, app } = signIn;
  const accepted = Boolean(input.code) && input.issuerOk && !input.declined;
  const outcome: Outcome =
    accepted && input.code ? { kind: "code", code: input.code } : { kind: "declined" };
  return {
    book: book.map((each) => (each === signIn ? { ...each, outcome } : each)),
    verdict: { kind: accepted ? "accepted" : "declined", account, app },
  };
}

/**
 * Spade asks for its sign-in with the PKCE verifier. Another account, or another app, finds
 * nothing and changes nothing.
 */
export function finish(
  book: Book,
  input: { handle: string; account: string; app: string; verifier: string },
  now: number,
): { book: Book; verdict: FinishVerdict } {
  const signIn = book.find((each) => each.handle === input.handle);
  if (!signIn || signIn.account !== input.account || signIn.app !== input.app)
    return { book, verdict: { kind: "unknown" } };
  const gone = without(book, signIn.handle);
  if (expired(signIn, now)) return { book: gone, verdict: { kind: "expired" } };
  if (!matchesChallenge(input.verifier, signIn.challenge))
    return { book: gone, verdict: { kind: "wrong_verifier" } };
  switch (signIn.outcome.kind) {
    case "waiting":
      return { book, verdict: { kind: "waiting" } };
    case "declined":
      return { book: gone, verdict: { kind: "declined" } };
    case "code":
      return {
        book: gone,
        verdict: { kind: "ready", code: signIn.outcome.code, publicKey: signIn.publicKey },
      };
  }
}

/** Sign-ins that are still alive at `now`. */
export function prune(book: Book, now: number): Book {
  return book.filter((each) => !expired(each, now));
}

/** When the next sign-in in the book runs out, if any. */
export function nextExpiry(book: Book): number | undefined {
  return book.length ? Math.min(...book.map((each) => each.startedMs + SIGN_IN_MS)) : undefined;
}

/**
 * RFC 7636 S256: the challenge is base64url(SHA-256(verifier)). Verifiers are 43 to 128
 * unreserved characters.
 */
export function matchesChallenge(verifier: string, challenge: string): boolean {
  return (
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
    encodeBase64url(sha256(new TextEncoder().encode(verifier))) === challenge
  );
}

/** A 43-character base64url S256 challenge. */
export function isChallenge(text: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(text);
}
