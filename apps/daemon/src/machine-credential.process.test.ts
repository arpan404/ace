import { expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeBase64url, standingProofText } from "@ace/account-grant";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
import { WebSocket } from "ws";
import { Client as AceClient, webSocketTransport } from "@ace/client";
import { makeStandingKey, proveStanding } from "@ace/client/standing";
import { DeviceId } from "@ace/protocol";
import { signInThroughWorker } from "@ace/cloud/testing";
import { redeemPairing } from "./client-access.ts";
import { token } from "./socket-test-support.ts";
import {
  useAccountBackend,
  person,
  signal,
  accounts,
  sessionFile,
  stored,
  backendKnows,
  deviceKey,
  changesGuardedSetting,
  changesGuardedSettingInBatch,
  proves,
  daemon,
  signedInDaemon,
  pairedSocket,
  pairedPerson,
  linkFrom,
} from "./machine-standing-test-support.ts";

// ADR 0190 end to end: a real daemon signed in through ace's account backend (the Worker and D1
// under Miniflare, against a fake WorkOS); see machine-standing-test-support.ts.

const backend = useAccountBackend();

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
    standingProofText({ host, nonce: socket.nonce, binding: undefined, grant: socket.grant.token }),
  );
  expect(await proves(socket.client, socket.grant.token, proof)).toBe(false);
  expect(await changesGuardedSetting(socket.client)).toBe(false);
  await daemonHome.close();
});

it("the person signing in in a browser acts as the person on the socket that proves it, and nowhere else", async () => {
  const daemonHome = await signedInDaemon();
  const { session, host, home, accountSocket, f } = daemonHome;
  const ownerFile = join(home, "ace-owner.json");
  const secondWindow = await daemonHome.pageSocket();
  expect(await changesGuardedSetting(secondWindow.client)).toBe(false);
  await expect(readFile(ownerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const key = await deviceKey();
  const socket = await accountSocket(session.token, key);
  const grant = socket.grant.standing;
  if (!grant) throw new Error("No person's grant");
  const proof = await key.sign(
    standingProofText({ host, nonce: socket.nonce, binding: undefined, grant }),
  );
  // Not the person until the socket proves it, whether it writes the setting alone or in a batch.
  expect(await changesGuardedSetting(socket.client)).toBe(false);
  expect(await changesGuardedSettingInBatch(socket.client)).toBe(false);
  expect(await proves(socket.client, grant, proof)).toBe(true);
  expect(JSON.parse(await readFile(ownerFile, "utf8"))).toEqual({ account: session.account.id });
  expect(await changesGuardedSetting(secondWindow.client)).toBe(false);
  expect(await changesGuardedSetting(socket.client)).toBe(true);
  expect(await changesGuardedSettingInBatch(socket.client)).toBe(true);
  // The same grant and proof, captured and sent on another socket, prove nothing there.
  const replay = await accountSocket(session.token);
  expect(await proves(replay.client, grant, proof)).toBe(false);
  expect(await changesGuardedSetting(replay.client)).toBe(false);
  // A proof the window made on another channel, as whoever answered it as this host (with the
  // relay key read from ACE_HOME) would relay to the real daemon with this socket's nonce.
  const relayed = await accountSocket(session.token, key);
  const relayedGrant = relayed.grant.standing ?? "";
  const elsewhere = await key.sign(
    standingProofText({
      host,
      nonce: relayed.nonce,
      binding: "their-own-handshake",
      grant: relayedGrant,
    }),
  );
  expect(await proves(relayed.client, relayedGrant, elsewhere)).toBe(false);
  // A pairing link the person's socket makes pairs a device that is the person's too, once it
  // proves it with the key it paired with; its bearer token alone is not.
  const url = await linkFrom(socket.client);
  expect(await pairedPerson(f, url)).toEqual({ bearer: false, proven: true });
  await daemonHome.close();
});

it("the app's own page proves the person's standing over the host token, and the host token alone, right after a sign-in, does nothing of the person's", async () => {
  const daemonHome = await signedInDaemon();
  const { f, host, session } = daemonHome;
  // A process with the host token, seconds after the person signed in: no person's setting and
  // no person's pairing link, whichever way it asks for one.
  const bare = await daemonHome.pageSocket();
  expect(await changesGuardedSetting(bare.client)).toBe(false);
  const viaHttp = await pairedSocket(f, () => f.pair(["read", "operate", "admin"]));
  expect(await changesGuardedSetting(viaHttp)).toBe(false);
  const viaSocket = await linkFrom(bare.client);
  expect(
    await changesGuardedSetting(await pairedSocket(f, () => redeemPairing(viaSocket, "Phone"))),
  ).toBe(false);
  // The app's page, its window signed in as the person: a real client over loopback with the
  // host token, proving with the prover the window runs and the challenge its welcome gave.
  const page = new AceClient({
    deviceId: DeviceId.parse("app-page"),
    transport: () => webSocketTransport(() => new WebSocket(f.server.url)),
    credential: async () => ({ token }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: randomUUID,
    now: Date.now,
  });
  void page.start();
  const challenges = page.standingChallenge();
  await expect.poll(() => challenges.getSnapshot(), { timeout: 10_000 }).toBeDefined();
  const challenge = challenges.getSnapshot();
  if (!challenge) throw new Error("No challenge");
  // The welcome names the relay key's host, not the home's id it names the daemon by.
  expect(challenge.host).toBe(host);
  const proven = await proveStanding({
    challenge,
    session: session.token,
    account: accounts(),
    key: await makeStandingKey(),
  });
  if (!proven) throw new Error("No proof");
  const result = await page.request({ type: "account.standing", ...proven });
  expect(result.result.ok).toBe(true);
  const changed = await page.request({
    type: "settings.set",
    key: "market.askBeforeAgentPublish",
    value: false,
    layer: { kind: "global" },
  });
  expect(changed.ok).toBe(true);
  await page.close();
  // The same page over the raw protocol, for the link it makes.
  const key = await deviceKey();
  const pageSocket = await daemonHome.pageSocket();
  const minted = await accounts().grant(
    session.token,
    { kind: "device", subject: "device", host: pageSocket.host, key: key.raw },
    signal(),
  );
  const pageGrant = minted.standing ?? "";
  const pageProof = await key.sign(
    standingProofText({
      host: pageSocket.host,
      nonce: pageSocket.nonce,
      binding: undefined,
      grant: pageGrant,
    }),
  );
  expect(await proves(pageSocket.client, pageGrant, pageProof)).toBe(true);
  const page2 = pageSocket;
  // A link it makes then pairs a device that is the person's, proven with its own key.
  const url = await linkFrom(page2.client);
  expect(await pairedPerson(f, url)).toEqual({ bearer: false, proven: true });
  await daemonHome.close();
});

it("an existing session file is exchanged once and removed, and an answer lost on the way is recovered", async () => {
  // An older daemon's `ace login` left the session in its file.
  const session = await signInThroughWorker(backend.worker.http, backend.workos, person, "legacy");
  const first = await daemon();
  await writeFile(
    sessionFile(first.home),
    JSON.stringify({ origin: backend.worker.http, ...session, source: "login" }),
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
  const older = await signInThroughWorker(backend.worker.http, backend.workos, person, "legacy");
  const second = await daemon();
  const credential = encodeBase64url(randomBytes(32));
  const exchangeKey = backend.personKeys.exchangeKey;
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
    JSON.stringify({ origin: backend.worker.http, ...older, source: "login" }),
  );
  await writeFile(
    join(second.home, "ace-account.pending.json"),
    JSON.stringify({
      origin: backend.worker.http,
      credential,
      source: "login",
      predecessor: older.token,
    }),
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

it("a handover asked for before a stop, whose machine signed in otherwise since, is given back on the next start", async () => {
  const daemonHome = await signedInDaemon();
  const kept = await stored(daemonHome.home);
  // Before a restart the daemon asked for a credential to replace a sign-in it no longer holds:
  // the backend issued it, the daemon never took it up.
  const later = await signInThroughWorker(backend.worker.http, backend.workos, person);
  const { ticket } = await accounts().machineEnrollment(later.token, daemonHome.host, signal());
  const exchangeKey = backend.personKeys.exchangeKey;
  if (!exchangeKey) throw new Error("No exchange key");
  const stale = encodeBase64url(randomBytes(32));
  await accounts().machineCredential(
    undefined,
    {
      hostId: daemonHome.host,
      hostKey: encodeBase64url(daemonHome.keys.publicKey),
      credential: stale,
      proof: machineCredentialProof({
        hostPrivateKey: daemonHome.keys.privateKey,
        exchangeKey,
        hostId: daemonHome.host,
        credential: stale,
      }),
      ticket,
    },
    signal(),
  );
  await writeFile(
    join(daemonHome.home, "ace-account.pending.json"),
    JSON.stringify({
      origin: backend.worker.http,
      credential: stale,
      source: "handover",
      predecessor: "p".repeat(43),
    }),
  );
  await daemonHome.account.load();
  await daemonHome.account.renew();
  // The machine keeps the sign-in it has; the stale credential is signed out at the backend.
  expect((await stored(daemonHome.home)).token).toBe(kept.token);
  expect(await backendKnows(stale)).toBe(false);
  await expect(readFile(join(daemonHome.home, "ace-account.pending.json"))).rejects.toThrow();
  await daemonHome.close();
});

it("a stop after a new credential is saved but before its pending file is cleared keeps that credential", async () => {
  const daemonHome = await signedInDaemon();
  const current = await stored(daemonHome.home);
  // The pending file still names the credential the daemon just adopted, and the sign-in it
  // replaced, which is no longer the machine's.
  await writeFile(
    join(daemonHome.home, "ace-account.pending.json"),
    JSON.stringify({
      origin: backend.worker.http,
      credential: current.token,
      source: "handover",
      predecessor: "p".repeat(43),
    }),
  );
  await daemonHome.account.load();
  await daemonHome.account.renew();
  expect((await stored(daemonHome.home)).token).toBe(current.token);
  expect(await backendKnows(current.token)).toBe(true);
  await expect(readFile(join(daemonHome.home, "ace-account.pending.json"))).rejects.toThrow();
  await daemonHome.close();
});
