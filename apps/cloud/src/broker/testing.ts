import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { GRANT_LIFETIME_MS, encodeBase64url, signCloudGrant, signGrant } from "@ace/account-grant";
import type { GrantSigningKey } from "@ace/account-grant";
import { appOf, begin, callback, finish } from "./sign-ins.ts";
import type { Book } from "./sign-ins.ts";
import type { SignInDirectory, SignInStore } from "./store.ts";
import { stateRoute } from "./store.ts";

/** Sign-ins kept in a map, through the same pure core the Durable Object uses. */
export function memorySignIns(): SignInDirectory & { held(): number } {
  const books = new Map<string, Book>();
  const routeOf = (account: string) =>
    Array.from(sha256(new TextEncoder().encode(account)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const store = (route: string): SignInStore => {
    const change = async <T>(apply: (book: Book) => { book: Book; verdict: T }) => {
      const { book, verdict } = apply(books.get(route) ?? []);
      books.set(route, book);
      return verdict;
    };
    return {
      begin: (signIn, now) =>
        change((book) => ({ book: begin(book, signIn, now), verdict: undefined })),
      appOf: async (state) => appOf(books.get(route) ?? [], state),
      callback: (input, now) => change((book) => callback(book, input, now)),
      finish: (input, now) => change((book) => finish(book, input, now)),
    };
  };
  return {
    forAccount: (account) => ({ store: store(routeOf(account)), route: routeOf(account) }),
    forState: (state) => {
      const route = stateRoute(state);
      return route ? store(route) : undefined;
    },
    held: () => [...books.values()].reduce((sum, book) => sum + book.length, 0),
  };
}

/** What Spade holds for one sign-in: a PKCE verifier and a one-time X25519 key. */
export function spadeSide(seed: number) {
  const verifier = encodeBase64url(new Uint8Array(32).fill(seed));
  const privateKey = new Uint8Array(32).fill(seed + 1);
  return {
    verifier,
    challenge: encodeBase64url(sha256(new TextEncoder().encode(verifier))),
    privateKey,
    publicKey: encodeBase64url(x25519.getPublicKey(privateKey)),
  };
}

/** Credentials as ace cloud's account API signs them. */
export function credentials(key: GrantSigningKey, now: number) {
  const claims = (account: string) => ({
    account,
    subject: "A".repeat(52),
    iat: now,
    exp: now + GRANT_LIFETIME_MS,
  });
  return {
    cloud: (account: string) => signCloudGrant({ ...claims(account), kind: "machine" }, key),
    machine: (account: string) => signGrant({ ...claims(account), kind: "machine" }, key),
    device: (account: string) => signGrant({ ...claims(account), kind: "device" }, key),
  };
}
