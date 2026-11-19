import { expect, it } from "vitest";
import { pairedStandingText, standingProofText } from "@ace/account-grant";
import { signInThroughWorker } from "@ace/cloud/testing";
import { PairingResponse } from "@ace/protocol";
import { redeemPairing } from "./client-access.ts";
import {
  useAccountBackend,
  other,
  signal,
  accounts,
  deviceKey,
  answer,
  changesGuardedSetting,
  proves,
  signedInDaemon,
  pairedChallenge,
  provesPaired,
  linkFrom,
  pageProves,
  person,
} from "./machine-standing-test-support.ts";

// ADR 0190 end to end, the machine's owner and its paired devices' keys: a real daemon signed
// in through ace's account backend (the Worker and D1 under Miniflare, against a fake WorkOS).
// Apart from machine-credential.process.test.ts so each file's backend stays inside its rate
// limit.

const backend = useAccountBackend();

it("a host-token handover to another account gives that account no person standing", async () => {
  const daemonHome = await signedInDaemon();
  const { session, host } = daemonHome;
  // The person's own proof makes their account the machine's owner.
  expect((await pageProves(daemonHome, session.token)).ok).toBe(true);
  // A process with the host token hands the machine to an account it signed in to itself.
  const theirs = await signInThroughWorker(backend.worker.http, backend.workos, other);
  const { ticket } = await accounts().machineEnrollment(theirs.token, host, signal());
  await daemonHome.account.handover(backend.worker.http, { ticket });
  expect(daemonHome.account.status()).toMatchObject({ account: { id: "user_q" } });
  // That account's genuine person's grant, proven properly, is not the person here: not over
  // the host token, and not as one of its account devices the machine now admits.
  const page = await pageProves(daemonHome, theirs.token);
  expect(page.ok).toBe(false);
  expect(await changesGuardedSetting(page.client)).toBe(false);
  const key = await deviceKey();
  const socket = await daemonHome.accountSocket(theirs.token, key);
  const grant = socket.grant.standing ?? "";
  const proof = await key.sign(
    standingProofText({ host, nonce: socket.nonce, binding: undefined, grant }),
  );
  expect(await proves(socket.client, grant, proof)).toBe(false);
  expect(await changesGuardedSetting(socket.client)).toBe(false);
  // The owner still is.
  const owner = await pageProves(daemonHome, session.token);
  expect(owner.ok).toBe(true);
  expect(await changesGuardedSetting(owner.client)).toBe(true);
  await daemonHome.close();
});

it("a host-token handover before the person's first proof doesn't make that handover's account the owner", async () => {
  // The person signed the machine in from their app, which hasn't proved anything here yet.
  const daemonHome = await signedInDaemon();
  const { session, host } = daemonHome;
  expect(daemonHome.account.status().owner).toBeNull();
  // A process with the host token switches it to an account it signed in to itself, and makes
  // no proof of its own.
  const theirs = await signInThroughWorker(backend.worker.http, backend.workos, other);
  const { ticket } = await accounts().machineEnrollment(theirs.token, host, signal());
  await daemonHome.account.handover(backend.worker.http, { ticket });
  expect(daemonHome.account.status()).toMatchObject({ account: { id: "user_q" }, owner: null });
  // The person's own proof, from their browser-signed-in session, makes them the owner, whatever
  // account the machine is signed in to now.
  const mine = await pageProves(daemonHome, session.token);
  expect(mine.ok).toBe(true);
  expect(daemonHome.account.status().owner).toEqual({ account: person.id });
  expect(await changesGuardedSetting(mine.client)).toBe(true);
  // And the handover's account, proving properly afterwards, is not the person here.
  const page = await pageProves(daemonHome, theirs.token);
  expect(page.ok).toBe(false);
  expect(await changesGuardedSetting(page.client)).toBe(false);
  await daemonHome.close();
});

it("the owner letting the machine go ends every standing proven under them and every person's pairing", async () => {
  const daemonHome = await signedInDaemon();
  const { session } = daemonHome;
  const owner = await pageProves(daemonHome, session.token);
  expect(owner.ok).toBe(true);
  const url = await linkFrom(owner.client);
  const kept = await pageProves(daemonHome, session.token);
  // A device paired from the owner's link, proven with its own key: the person's, but it can't
  // let the machine go; nor can a socket that proved nothing.
  const key = await deviceKey();
  const paired = await pairedChallenge(daemonHome.f, async () =>
    redeemPairing(await linkFrom(owner.client), "Phone", undefined, key.raw),
  );
  const pairedProof = await key.sign(
    pairedStandingText({
      host: paired.host,
      nonce: paired.nonce,
      binding: undefined,
      deviceId: paired.device,
    }),
  );
  expect(await provesPaired(paired.client, pairedProof)).toBe(true);
  const release = async (client: typeof owner.client) => {
    client.send({ type: "account.owner.release", requestId: "release" });
    return (await answer(client, "account.owner.release.result")).ok;
  };
  expect(await release(paired.client)).toBe(false);
  const bare = await daemonHome.pageSocket();
  expect(await release(bare.client)).toBe(false);
  expect(daemonHome.account.status().owner).toEqual({ account: person.id });
  expect(await release(owner.client)).toBe(true);
  expect(daemonHome.account.status().owner).toBeNull();
  // Every socket proven under the old owner is no longer the person's, the paired device's key
  // proves nothing any more, and the pending link is void.
  expect(await changesGuardedSetting(kept.client)).toBe(false);
  expect(await changesGuardedSetting(paired.client)).toBe(false);
  expect(await provesPaired(paired.client, pairedProof)).toBe(false);
  await expect(redeemPairing(url, "Phone")).rejects.toThrow();

  // The owner proves again, and a proof of theirs that began before a release lands after it:
  // it doesn't reclaim the machine.
  expect((await pageProves(daemonHome, session.token)).ok).toBe(true);
  const deviceKeyPair = await deviceKey();
  const nonce = "a-socket-nonce";
  const minted = await accounts().grant(
    session.token,
    { kind: "device", subject: "device", host: daemonHome.host, key: deviceKeyPair.raw },
    signal(),
  );
  const grant = minted.standing ?? "";
  const proof = await deviceKeyPair.sign(
    standingProofText({ host: daemonHome.host, nonce, binding: undefined, grant }),
  );
  const proving = daemonHome.account.proveStanding({
    grant,
    proof,
    nonce,
    binding: undefined,
    deviceId: "device",
  });
  const releasing = daemonHome.account.releaseOwner(() => {});
  expect(await proving).toBeUndefined();
  await releasing;
  expect(daemonHome.account.status().owner).toBeNull();
  // The same proof, begun after the release: it is the next owner's first.
  expect(
    await daemonHome.account.proveStanding({
      grant,
      proof,
      nonce,
      binding: undefined,
      deviceId: "device",
    }),
  ).toBeDefined();
  await daemonHome.close();
});

it("a paired device's bearer token, without its own key's proof on that very socket, is never the person", async () => {
  const daemonHome = await signedInDaemon();
  const { f, session } = daemonHome;
  const owner = await pageProves(daemonHome, session.token);
  const key = await deviceKey();
  const credential = await redeemPairing(await linkFrom(owner.client), "Phone", undefined, key.raw);
  const paired = await pairedChallenge(f, async () => credential);
  const signed = (input: { nonce?: string; binding?: string; deviceId?: string }) =>
    key.sign(
      pairedStandingText({
        host: paired.host,
        nonce: input.nonce ?? paired.nonce,
        binding: input.binding,
        deviceId: input.deviceId ?? paired.device,
      }),
    );
  expect(await changesGuardedSetting(paired.client)).toBe(false);
  // Made for another socket, another channel or another device: refused.
  expect(await provesPaired(paired.client, await signed({ nonce: "another-socket" }))).toBe(false);
  expect(await provesPaired(paired.client, await signed({ binding: "another-channel" }))).toBe(
    false,
  );
  expect(await provesPaired(paired.client, await signed({ deviceId: "another-device" }))).toBe(
    false,
  );
  // Signed by any key but the one it paired with: refused.
  const stranger = await deviceKey();
  const strangers = await stranger.sign(
    pairedStandingText({
      host: paired.host,
      nonce: paired.nonce,
      binding: undefined,
      deviceId: paired.device,
    }),
  );
  expect(await provesPaired(paired.client, strangers)).toBe(false);
  expect(await changesGuardedSetting(paired.client)).toBe(false);
  // The same token on a second socket, with the proof made for the first one: refused there.
  const proof = await signed({});
  const second = await pairedChallenge(f, async () => credential);
  expect(await provesPaired(second.client, proof)).toBe(false);
  expect(await changesGuardedSetting(second.client)).toBe(false);
  // Its own key, on its own socket: the person.
  expect(await provesPaired(paired.client, proof)).toBe(true);
  expect(await changesGuardedSetting(paired.client)).toBe(true);
  // A device paired from the person's link by an app that names no key never is: an admin
  // the CLI paired, its bearer saved on disk.
  const keylessCredential = await redeemPairing(await linkFrom(owner.client), "Old phone");
  const keyless = await pairedChallenge(f, async () => keylessCredential);
  const keylessProof = await key.sign(
    pairedStandingText({
      host: keyless.host,
      nonce: keyless.nonce,
      binding: undefined,
      deviceId: keyless.device,
    }),
  );
  expect(await provesPaired(keyless.client, keylessProof)).toBe(false);
  expect(await changesGuardedSetting(keyless.client)).toBe(false);
  // Whoever holds that bearer makes a link over HTTP and redeems it with a key of its own: an
  // ordinary pairing, never the person's. Nor is one the person's keyed device makes over HTTP.
  for (const bearer of [keylessCredential.token, credential.token]) {
    const link = PairingResponse.parse(
      await f.remoteRequest("/v1/pairings", {
        method: "POST",
        token: bearer,
        body: { scopes: ["read", "operate", "admin"] },
      }),
    );
    const theirKey = await deviceKey();
    const theirs = await pairedChallenge(f, () =>
      redeemPairing(link.url, "Their phone", undefined, theirKey.raw),
    );
    const theirProof = await theirKey.sign(
      pairedStandingText({
        host: theirs.host,
        nonce: theirs.nonce,
        binding: undefined,
        deviceId: theirs.device,
      }),
    );
    expect(await provesPaired(theirs.client, theirProof)).toBe(false);
    expect(await changesGuardedSetting(theirs.client)).toBe(false);
  }
  await daemonHome.close();
});
