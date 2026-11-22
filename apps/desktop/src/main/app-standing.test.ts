import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { verifyStatement, type PersonStatement } from "@ace/account-grant/person-statement";
import { appStanding, ENROLL_WINDOW_MS, type DaemonHttp } from "./app-standing.ts";
import { standingKeys, type Sealer } from "./standing-key.ts";

/*
 * Main owns the whole exchange (ADR 0190, amendment 1): a window only asks, main fetches the
 * challenge, signs a statement for the tags it made and sends it; enrolling follows a browser
 * sign-in; signing out revokes the key at the daemon.
 */

const origin = "https://acehq.dev";
const host = "H".repeat(52);
const sealer: Sealer = {
  available: () => true,
  seal: (text) => Buffer.from(text, "utf8"),
  open: (bytes) => bytes.toString("utf8"),
};

/** A daemon that checks statements as the real one does and records what it was sent. */
function daemon(owner = "user_1") {
  const nonces = new Set<string>();
  const keys = new Set<string>();
  const seen: PersonStatement[] = [];
  const revoked: string[] = [];
  const http: DaemonHttp = async (method, path, body) => {
    if (path === "/v1/standing/app/challenge") {
      const nonce = randomBytes(32).toString("base64url");
      nonces.add(nonce);
      return { status: 200, body: { nonce, host, owner } };
    }
    if (method === "DELETE") {
      revoked.push((body as { key: string }).key);
      keys.delete((body as { key: string }).key);
      return { status: 200, body: { proven: 0 } };
    }
    const sent = body as { statement: string; proof: string; key: string };
    const statement = await verifyStatement({
      text: sent.statement,
      proof: sent.proof,
      publicKey: sent.key,
      now: Date.now(),
    });
    if (!statement || !nonces.delete(statement.nonce)) return { status: 403, body: {} };
    seen.push(statement);
    if (path === "/v1/standing/app/key") {
      keys.add(sent.key);
      return { status: 200, body: { proven: 0 } };
    }
    if (!keys.has(sent.key)) return { status: 200, body: { proven: 0 } };
    return { status: 200, body: { proven: statement.target.split(",").length } };
  };
  return { http, seen, revoked, keys };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-app-standing-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function setup(options: { allowed?: boolean; answeringHost?: string; now?: () => number } = {}) {
  const d = daemon();
  const tags = ["a".repeat(43), "b".repeat(43)];
  let token: string | null = "s".repeat(43);
  const standing = appStanding({
    keys: standingKeys(directory, sealer),
    allowed: async () => options.allowed ?? true,
    tags: () => tags,
    daemon: async () => ({ http: d.http, host: options.answeringHost ?? host }),
    session: async () => token,
    accountOf: async () => "user_1",
    now: options.now ?? Date.now,
  });
  return {
    d,
    tags,
    standing,
    signIn: async (next: string) => {
      token = next;
      await standing.signedIn(origin, next);
    },
    signOut: async () => {
      token = null;
      await standing.signedOut(origin);
    },
  };
}

test("a window only asks: main proves the tags it made, over the daemon's own challenge", async () => {
  const { d, tags, standing, signIn } = setup();
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
  expect(await standing.prove(origin)).toBe(true);
  const proof = d.seen.at(-1);
  expect(proof).toMatchObject({
    account: "user_1",
    purpose: "standing",
    action: "socket",
    target: tags.join(","),
    audience: host,
  });
  expect((proof?.exp ?? 0) - (proof?.iat ?? 0)).toBeLessThanOrEqual(60_000);
});

test("enrolling takes a browser sign-in in the last ten minutes", async () => {
  let now = 1_800_000_000_000;
  const { standing, signIn } = setup({ now: () => now });
  expect(await standing.enroll(origin)).toBe(false);
  await signIn("s".repeat(43));
  now += ENROLL_WINDOW_MS + 1;
  expect(await standing.enroll(origin)).toBe(false);
});

test("signing out revokes the key at the daemon, and another session's sign-in revokes the one before", async () => {
  const { d, standing, signIn, signOut } = setup();
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
  const first = [...d.keys][0];
  await signIn("t".repeat(43));
  expect(d.revoked).toEqual([first]);
  expect(await standing.prove(origin)).toBe(false);
  expect(await standing.enroll(origin)).toBe(true);
  const second = [...d.keys][0];
  await signOut();
  expect(d.revoked).toEqual([first, second]);
  expect(await standing.prove(origin)).toBe(false);
});

test("a build that may not keep a key, or a daemon answering for another host, gets no statement", async () => {
  const locked = setup({ allowed: false });
  await locked.signIn("s".repeat(43));
  expect(await locked.standing.enroll(origin)).toBe(false);
  expect(await locked.standing.prove(origin)).toBe(false);
  expect(locked.d.seen).toEqual([]);
  const impostor = setup({ answeringHost: "I".repeat(52) });
  await impostor.signIn("s".repeat(43));
  expect(await impostor.standing.enroll(origin)).toBe(false);
  expect(impostor.d.seen).toEqual([]);
});
