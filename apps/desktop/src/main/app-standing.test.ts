import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appSocketTag,
  enrollAction,
  possessionMac,
  socketsTarget,
  x25519Ephemeral,
  x25519Shared,
} from "@ace/account-grant/app-channel";
import { verifyStatement, type PersonStatement } from "@ace/account-grant/person-statement";
import { APP_STANDING_MAX_SOCKETS } from "@ace/protocol";
import { appStanding, ENROLL_WINDOW_MS, type DaemonHttp } from "./app-standing.ts";
import { standingKeys, type Sealer } from "./standing-key.ts";

/*
 * Main owns the whole exchange (ADR 0190, amendment 1): the daemon proves it holds the relay key
 * main pinned; main proves the live sockets behind its own tags in batches; enrolling follows a
 * new browser session and carries the backend's word on it; signing out keeps the revocation
 * until the daemon acknowledges it, after any enrollment in flight.
 */

const origin = "https://acehq.dev";
const host = "H".repeat(52);
const sealer: Sealer = {
  available: () => true,
  seal: (text) => Buffer.from(text, "utf8"),
  open: (bytes) => bytes.toString("utf8"),
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * A daemon holding the relay key `relay`, with live sockets for `tags`, that checks statements
 * as the real one does and records what it was sent. `down`: it answers nothing.
 */
function daemon(tags: readonly string[], relay = x25519Ephemeral(), now: () => number = Date.now) {
  const nonces = new Set<string>();
  const keys = new Set<string>();
  const statements: PersonStatement[] = [];
  const revoked: string[] = [];
  const proven = new Set<string>();
  const live = new Map(tags.map((tag) => [tag, randomBytes(16).toString("base64url")]));
  const state: {
    down: boolean;
    hold?: Promise<void> | undefined;
    reached?: (() => void) | undefined;
  } = { down: false };
  const http: DaemonHttp = async (method, path, body) => {
    if (state.down) throw new Error("connection refused");
    if (path === "/v1/standing/app/challenge") {
      const asked = body as { ephemeral: string; tags: string[] };
      const nonce = randomBytes(32).toString("base64url");
      nonces.add(nonce);
      const sockets = asked.tags.flatMap((tag) => {
        const connection = live.get(tag);
        return connection ? [{ tag, connection }] : [];
      });
      const reply = { nonce, host, owner: "user_1", sockets };
      const shared = x25519Shared(relay.privateKey, Buffer.from(asked.ephemeral, "base64url"));
      return { status: 200, body: { ...reply, possession: possessionMac(shared, reply) } };
    }
    if (method === "DELETE") {
      const { key } = body as { key: string };
      revoked.push(key);
      keys.delete(key);
      return { status: 200, body: { proven: 0 } };
    }
    const sent = body as {
      statement: string;
      proof: string;
      key: string;
      sockets: { tag: string; connection: string }[];
      signIn?: string;
    };
    const statement = await verifyStatement({
      text: sent.statement,
      proof: sent.proof,
      publicKey: sent.key,
      now: now(),
    });
    if (!statement || !nonces.delete(statement.nonce)) return { status: 403, body: {} };
    if (
      statement.target !== socketsTarget(sent.sockets) ||
      sent.sockets.length > APP_STANDING_MAX_SOCKETS
    )
      return { status: 403, body: {} };
    statements.push(statement);
    if (path === "/v1/standing/app/key") {
      state.reached?.();
      await state.hold;
      const vouched = `vouched:${enrollAction({ host, device: statement.device, nonce: statement.nonce })}`;
      if (sent.signIn !== vouched) return { status: 403, body: {} };
      keys.add(sent.key);
      return { status: 200, body: { proven: 0 } };
    }
    if (!keys.has(sent.key)) return { status: 200, body: { proven: 0 } };
    for (const socket of sent.sockets) proven.add(socket.tag);
    return { status: 200, body: { proven: sent.sockets.length } };
  };
  return { http, relay, keys, statements, revoked, proven, state };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-app-standing-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function setup(
  options: {
    allowed?: boolean;
    tags?: number;
    now?: () => number;
    /** The relay key the home names, when it isn't the daemon's. */
    home?: Uint8Array;
    /** The relay key whatever answers holds. */
    relay?: ReturnType<typeof x25519Ephemeral>;
  } = {},
) {
  const tags = Array.from({ length: options.tags ?? 2 }, () =>
    appSocketTag(Date.now(), randomBytes(32)),
  );
  const d = daemon(tags, options.relay, options.now);
  let token: string | null = null;
  const keys = standingKeys(directory, sealer);
  const standing = appStanding({
    keys,
    allowed: async () => options.allowed ?? true,
    tags: () => tags,
    daemon: async () => ({
      http: d.http,
      host,
      relayPublicKey: b64(options.home ?? d.relay.publicKey),
    }),
    session: async () => token,
    accountOf: async () => "user_1",
    // The backend's word on a recent sign-in, as the fake daemon expects it.
    signInGrant: async (_origin, _token, action) => `vouched:${action}`,
    now: options.now ?? Date.now,
  });
  return {
    d,
    tags,
    keys,
    standing,
    signIn: async (next: string) => {
      const previous = token;
      token = next;
      await standing.signedIn(origin, next, previous);
    },
    signOut: async () => {
      token = null;
      await standing.signedOut(origin);
    },
  };
}

test("after a new browser session, main enrolls and proves the live sockets behind its own tags", async () => {
  const { d, tags, standing, signIn } = setup();
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
  expect(await standing.prove(origin)).toBe(true);
  expect([...d.proven].toSorted()).toEqual([...tags].toSorted());
  expect(d.statements.at(-1)).toMatchObject({
    account: "user_1",
    purpose: "standing",
    audience: host,
  });
});

test("past one statement's worth of sockets, main proves them in batches", async () => {
  const { d, tags, standing, signIn } = setup({ tags: APP_STANDING_MAX_SOCKETS * 2 + 3 });
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
  expect(d.proven.size).toBe(tags.length);
  expect(d.statements.filter((s) => s.purpose === "standing")).toHaveLength(3);
});

test("a sign-in counts for ten minutes, and rewriting the same session never refreshes it", async () => {
  let now = Date.now();
  const { standing, signIn } = setup({ now: () => now });
  await signIn("s".repeat(43));
  now += ENROLL_WINDOW_MS + 1;
  expect(await standing.enroll(origin)).toBe(false);
  // The renderer writes the session it already had: still no sign-in to enroll with.
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(false);
  // A new session is one.
  await signIn("t".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
});

test("a daemon that can't prove it holds the pinned relay key gets no statement", async () => {
  // The home names one relay key; whatever answers holds another.
  const { d, standing, signIn } = setup({ home: x25519Ephemeral().publicKey });
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(false);
  expect(d.statements).toEqual([]);
});

test("once pinned, a home naming another relay key doesn't move the pin", async () => {
  const first = setup();
  await first.signIn("s".repeat(43));
  expect(await first.standing.enroll(origin)).toBe(true);
  const pinned = await first.keys.pin();
  expect(pinned).toBe(b64(first.d.relay.publicKey));
  // Another start: the home names a new key, and whatever answers holds it; the pin stays.
  const impostor = x25519Ephemeral();
  const later = setup({ home: impostor.publicKey, relay: impostor });
  expect(await later.keys.pin()).toBe(pinned);
  await later.signIn("t".repeat(43));
  expect(await later.standing.enroll(origin)).toBe(false);
});

test("sign-out keeps the revocation until the daemon acknowledges it, after any enrollment in flight", async () => {
  const { d, keys, standing, signIn, signOut } = setup();
  await signIn("s".repeat(43));
  // Sign-out arrives while an enrollment is on its way to the daemon: it waits, then revokes
  // what was enrolled.
  const gate = Promise.withResolvers<void>();
  d.state.hold = gate.promise;
  const reached = new Promise<void>((resolve) => (d.state.reached = resolve));
  const enrolled = standing.enroll(origin);
  await reached;
  const out = signOut();
  gate.resolve();
  await enrolled;
  await out;
  d.state.hold = undefined;
  d.state.reached = undefined;
  expect(d.keys.size).toBe(0);
  expect(d.revoked).toHaveLength(1);
  // A sign-out the daemon never heard: the key can sign nothing, and its revocation waits.
  await signIn("t".repeat(43));
  expect(await standing.enroll(origin)).toBe(true);
  d.state.down = true;
  await signOut();
  expect(await keys.pending()).toHaveLength(1);
  expect(d.keys.size).toBe(1);
  d.state.down = false;
  await standing.retry();
  expect(await keys.pending()).toEqual([]);
  expect(d.keys.size).toBe(0);
});

test("a build that may not keep a key enrolls and proves nothing", async () => {
  const { d, standing, signIn } = setup({ allowed: false });
  await signIn("s".repeat(43));
  expect(await standing.enroll(origin)).toBe(false);
  expect(await standing.prove(origin)).toBe(false);
  expect(d.statements).toEqual([]);
});
