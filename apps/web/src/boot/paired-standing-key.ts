import { makeStandingKeyPair, standingKeyOf, type StandingKey } from "@ace/client/standing";

/*
 * The key this browser proves the person's standing with on the machines it paired from a
 * person's link (ADR 0190). Its private half is made non-extractable and kept, as a CryptoKey,
 * in this origin's IndexedDB: nothing can read it out, and only pages of this origin can sign
 * with it. The daemon learns its public half at redemption; a bearer token taken on the way
 * proves nothing without it. One key serves every machine: each proof names its host and socket.
 */

const DATABASE = "ace-standing";
const STORE = "keys";
const ENTRY = "paired";

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, 1);
  request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
  return done(request);
}

const isPair = (value: unknown): value is CryptoKeyPair =>
  typeof value === "object" &&
  value !== null &&
  "privateKey" in value &&
  "publicKey" in value &&
  value.privateKey instanceof CryptoKey &&
  value.publicKey instanceof CryptoKey;

let kept: Promise<StandingKey | undefined> | undefined;

async function load(): Promise<StandingKey | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await open();
  try {
    const stored: unknown = await done(db.transaction(STORE).objectStore(STORE).get(ENTRY));
    if (isPair(stored)) return await standingKeyOf(stored);
    const pair = await makeStandingKeyPair();
    // Never replaces one another tab kept first: `add` fails, and that one is read instead.
    const added = await done(
      db.transaction(STORE, "readwrite").objectStore(STORE).add(pair, ENTRY),
    ).then(
      () => true,
      () => false,
    );
    if (added) return await standingKeyOf(pair);
    const winner: unknown = await done(db.transaction(STORE).objectStore(STORE).get(ENTRY));
    return isPair(winner) ? await standingKeyOf(winner) : undefined;
  } finally {
    db.close();
  }
}

/** This browser's paired standing key, made the first time; undefined without IndexedDB. */
export function pairedStandingKey(): Promise<StandingKey | undefined> {
  kept ??= load().catch((error: unknown) => {
    kept = undefined;
    throw error;
  });
  return kept;
}
