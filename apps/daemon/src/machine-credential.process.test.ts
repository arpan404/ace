import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GrantKeySet, encodeBase64url, standingProofText } from "@ace/account-grant";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { DeviceId, FleetResult, type ServerMessage } from "@ace/protocol";
import { SettingsService, fileIO } from "@ace/settings";
import { hostId } from "@ace/secure-channel";
import {
  fakeWorkos,
  signInThroughWorker,
  startRelayWorker,
  type WorkosUser,
} from "@ace/cloud/testing";
import { machineAccount, type MachineAccount } from "./account-access/machine-account.ts";
import { relayKeysFor } from "./account-access/relay-host-id.ts";
import { StoredSession } from "./account-access/session-file.ts";
import { redeemPairing } from "./client-access.ts";
import { setup } from "./remote-test-support.ts";
import type { Client } from "./socket-test-support.ts";

// ADR 0190 end to end: a real daemon signed in through ace's account backend (the Worker and D1
// under Miniflare, against a fake WorkOS). A process holding only what the daemon writes to
// ACE_HOME never gets the person's standing; the person, signed in in a browser, does, on the
// socket that proves it. The person-only action observed is "Ask me before agents publish",
// which the daemon changes for a credential that isn't the person's only after a fresh sign-in.

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startRelayWorker>>;
let personKeys: GrantKeySet;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startRelayWorker({ workosUrl: workos.url });
  personKeys = GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());
});
afterAll(async () => {
  await worker?.close();
  await workos?.close();
});

const person: WorkosUser = {
  id: "user_p",
  email: "p@example.com",
  first_name: "Pat",
  last_name: null,
  email_verified: true,
};
const signal = () => AbortSignal.timeout(15_000);
const accounts = () => aceAccountClient({ origin: worker.http, fetch: globalThis.fetch });
const sessionFile = (home: string) => join(home, "ace-account.json");
const stored = async (home: string) =>
  StoredSession.parse(JSON.parse(await readFile(sessionFile(home), "utf8")));
const backendKnows = async (token: string) => {
  try {
    await accounts().session(token, signal());
    return true;
  } catch (error) {
    if (error instanceof AceAccountError && error.status === 401) return false;
    throw error;
  }
};

/** A device's P-256 key, made as the web app makes one. */
async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const raw = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const sign = async (text: string) =>
    encodeBase64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
    );
  return { raw, sign };
}

async function answer<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

/** Tries to turn "Ask me before agents publish" off: true when the daemon let this socket. */
async function changesGuardedSetting(client: Client): Promise<boolean> {
  client.send({
    type: "settings.set",
    requestId: "ask",
    key: "market.askBeforeAgentPublish",
    value: false,
    layer: { kind: "global" },
  });
  return (await answer(client, "settings.result")).ok;
}

/** Proves the person's standing on `client` with `grant` and `proof`: true when it took. */
async function proves(client: Client, grant: string, proof: string): Promise<boolean> {
  client.send({ type: "account.standing", requestId: "standing", grant, proof });
  return (await answer(client, "account.standing.result")).result.ok;
}

/** A daemon on ace's account backend, trusting the backend's keys as a build pins its own. */
async function daemon() {
  let account: MachineAccount | undefined;
  let home = "";
  let settings: SettingsService | undefined;
  const f = await setup({}, (store, dir) => {
    home = dir;
    settings = new SettingsService({
      dataDir: dir,
      io: { ...fileIO, watch: async () => () => {} },
    });
    account = machineAccount({
      relayKeys: () => relayKeysFor(dir),
      personKeys,
      // The issuer the test Worker names: its public URL's host, http://127.0.0.1.
      marketIssuer: "127.0.0.1",
      dataDir: dir,
      codes: store.machineCodes,
      fetch: globalThis.fetch,
      now: Date.now,
      randomBytes,
      delay: () => () => {},
    });
    return { machineAccount: account, settings };
  });
  if (!account) throw new Error("No machine account");
  const machine = account;
  const keys = await relayKeysFor(home);
  const host = hostId(keys.publicKey);

  /** An account device's socket, its grant minted with `token` for this daemon. */
  async function accountSocket(token: string, key?: Awaited<ReturnType<typeof deviceKey>>) {
    const grant = await accounts().grant(
      token,
      { kind: "device", subject: "phone", host, ...(key ? { key: key.raw } : {}) },
      signal(),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      grant: grant.token,
    });
    const welcome = await answer(client, "welcome");
    if (!welcome.standingNonce) throw new Error("No standing nonce");
    return { client, grant, nonce: welcome.standingNonce };
  }
  return {
    f,
    account: machine,
    home,
    host,
    keys,
    accountSocket,
    close: async () => {
      await machine.close();
      settings?.close();
    },
  };
}

/** The app signed in in the person's browser hands its daemon an enrollment ticket. */
async function signedInDaemon() {
  const session = await signInThroughWorker(worker.http, workos, person);
  const machine = await daemon();
  await machine.account.load();
  const { ticket } = await accounts().machineEnrollment(session.token, machine.host, signal());
  await machine.account.handover(worker.http, { ticket });
  return { ...machine, session };
}

/** A paired device's welcomed socket, from a pairing redeemed with `pair`. */
async function pairedSocket(
  f: Awaited<ReturnType<typeof daemon>>["f"],
  pair: () => Promise<{ token: string; device: { id: string } }>,
) {
  const paired = await pair();
  const ticket = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, ticket.ticket);
  await answer(client, "welcome");
  return client;
}

/** A pairing link made over `client`'s socket (`fleet.request`). */
async function linkFrom(client: Client): Promise<string> {
  client.send({
    type: "fleet.request",
    requestId: "pair",
    operation: { op: "pairing", scopes: ["read", "operate", "admin"] },
  });
  const issued = FleetResult.shape.result.parse((await answer(client, "fleet.result")).result);
  if (issued.kind !== "pairing") throw new Error("No pairing issued");
  return issued.url;
}

it("a process that reads ace-account.json can't act as the person", async () => {
  const daemonHome = await signedInDaemon();
  const { home, session, host, accountSocket } = daemonHome;
  // What the daemon wrote is its machine credential; the app's session never reaches it.
  expect(await readFile(sessionFile(home), "utf8")).not.toContain(session.token);
  const file = await stored(home);
  expect(file.kind).toBe("machine");
  // A same-user process reads it, makes itself a device key and connects as an account device:
  // admin, but the backend gives it no person's grant, and its own grant proves nothing.
  const thief = await deviceKey();
  const socket = await accountSocket(file.token, thief);
  expect(socket.grant.standing).toBeUndefined();
  const proof = await thief.sign(
    standingProofText({ host, nonce: socket.nonce, grant: socket.grant.token }),
  );
  expect(await proves(socket.client, socket.grant.token, proof)).toBe(false);
  expect(await changesGuardedSetting(socket.client)).toBe(false);
  await daemonHome.close();
});

it("the person signing in in a browser acts as the person on the socket that proves it, and nowhere else", async () => {
  const daemonHome = await signedInDaemon();
  const { session, host, accountSocket, f } = daemonHome;
  const key = await deviceKey();
  const socket = await accountSocket(session.token, key);
  const grant = socket.grant.standing;
  if (!grant) throw new Error("No person's grant");
  const proof = await key.sign(standingProofText({ host, nonce: socket.nonce, grant }));
  // Not the person until the socket proves it.
  expect(await changesGuardedSetting(socket.client)).toBe(false);
  expect(await proves(socket.client, grant, proof)).toBe(true);
  expect(await changesGuardedSetting(socket.client)).toBe(true);
  // The same grant and proof, captured and sent on another socket, prove nothing there.
  const replay = await accountSocket(session.token);
  expect(await proves(replay.client, grant, proof)).toBe(false);
  expect(await changesGuardedSetting(replay.client)).toBe(false);
  // A pairing link the person's socket makes pairs a device that is the person's too.
  const url = await linkFrom(socket.client);
  expect(
    await changesGuardedSetting(await pairedSocket(f, () => redeemPairing(url, "Phone"))),
  ).toBe(true);
  await daemonHome.close();
});

it("the host token makes a person's pairing link only right after a browser sign-in", async () => {
  const daemonHome = await signedInDaemon();
  const { f } = daemonHome;
  // POST /v1/pairings with the host token, the sign-in seconds old: the person's.
  const fresh = await pairedSocket(f, () => f.pair(["read", "operate", "admin"]));
  expect(await changesGuardedSetting(fresh)).toBe(true);
  // Ten minutes on, the host token alone, either way it makes a link, pairs no person.
  await worker.ageSignIns(11 * 60_000);
  const stale = await pairedSocket(f, () => f.pair(["read", "operate", "admin"]));
  expect(await changesGuardedSetting(stale)).toBe(false);
  const host = await f.connect();
  await answer(host, "welcome");
  const url = await linkFrom(host);
  expect(
    await changesGuardedSetting(await pairedSocket(f, () => redeemPairing(url, "Phone"))),
  ).toBe(false);
  await daemonHome.close();
});

it("an existing session file is exchanged once and removed, and an answer lost on the way is recovered", async () => {
  // An older daemon's `ace login` left the session in its file.
  const session = await signInThroughWorker(worker.http, workos, person, "legacy");
  const first = await daemon();
  await writeFile(
    sessionFile(first.home),
    JSON.stringify({ origin: worker.http, ...session, source: "login" }),
    { mode: 0o600 },
  );
  await first.account.load();
  await expect
    .poll(async () => (await stored(first.home)).kind, { timeout: 10_000 })
    .toBe("machine");
  const exchanged = await stored(first.home);
  expect(await readFile(sessionFile(first.home), "utf8")).not.toContain(session.token);
  expect(first.account.status()).toMatchObject({ signedIn: true, account: { id: "user_p" } });
  expect(first.account.status().signInAgain).toBeUndefined();
  // Whoever copied the file before the upgrade holds a token that no longer works.
  expect(await backendKnows(session.token)).toBe(false);
  // Once: a restart reads the credential and keeps it.
  await first.account.load();
  await first.account.renew();
  expect((await stored(first.home)).token).toBe(exchanged.token);
  await first.close();

  // Another daemon asked for its credential and stopped before the answer came: its file still
  // names the session the backend already retired, and its pending credential is the one issued.
  const older = await signInThroughWorker(worker.http, workos, person, "legacy");
  const second = await daemon();
  const credential = encodeBase64url(randomBytes(32));
  const exchangeKey = personKeys.exchangeKey;
  if (!exchangeKey) throw new Error("No exchange key");
  await accounts().machineCredential(
    older.token,
    {
      hostId: second.host,
      hostKey: encodeBase64url(second.keys.publicKey),
      credential,
      proof: machineCredentialProof({
        hostPrivateKey: second.keys.privateKey,
        exchangeKey,
        hostId: second.host,
        credential,
      }),
      sole: true,
      exposed: true,
    },
    signal(),
  );
  await writeFile(
    sessionFile(second.home),
    JSON.stringify({ origin: worker.http, ...older, source: "login" }),
  );
  await writeFile(
    join(second.home, "ace-account.pending.json"),
    JSON.stringify({ origin: worker.http, credential, source: "login" }),
  );
  await second.account.load();
  await expect
    .poll(async () => (await stored(second.home)).token, { timeout: 10_000 })
    .toBe(credential);
  expect((await stored(second.home)).kind).toBe("machine");
  expect(second.account.status().signedIn).toBe(true);
  await second.close();
});

it("the app hands its daemon a ticket for its host id, never its session, and keeps its own", async () => {
  const daemonHome = await signedInDaemon();
  const { home, session } = daemonHome;
  const file = await stored(home);
  expect(file).toMatchObject({ kind: "machine", source: "handover" });
  expect(file.token).not.toBe(session.token);
  expect(await backendKnows(session.token)).toBe(true);
  expect(daemonHome.account.status().relayHostId).toBe(daemonHome.host);
  await daemonHome.close();
});
