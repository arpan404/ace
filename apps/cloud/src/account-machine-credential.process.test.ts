import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  GRANT_SUBPROTOCOL_PREFIX,
  GrantKeySet,
  encodeBase64url,
  verifyGrant,
  verifyMarketGrant,
  verifyStandingGrant,
} from "@ace/account-grant";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { connectHostToRelay } from "@ace/relay";
import { hostId, keyPair, type KeyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { startWorker, upgrade } from "./testing/harness.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * ADR 0190 against the real Worker and D1 under Miniflare: what a machine keeps can never mint a
 * grant that speaks for the person, and older daemons are never handed a device grant a machine
 * minted. A real Worker because the rules live in its routes, its SQL batches and its migration.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterEach(() => workos.fail());
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const person: WorkosUser = {
  id: "user_m",
  email: "m@example.com",
  first_name: "Mia",
  last_name: null,
  email_verified: true,
};
const signal = () => AbortSignal.timeout(20_000);
const account = () => aceAccountClient({ origin: worker.http, fetch });
const keys = async () => GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());
const credentialToken = () => encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
const P256_KEY = encodeBase64url(new Uint8Array(65).fill(4));

/** A daemon's request for `credential` as machine `host`'s, proven with its host key. */
async function asMachine(
  host: KeyPair,
  credential: string,
  extra: { sole?: boolean; ticket?: string; proofHost?: KeyPair } = {},
) {
  const exchangeKey = (await keys()).exchangeKey;
  if (!exchangeKey) throw new Error("No exchange key published");
  const id = hostId(host.publicKey);
  return {
    hostId: id,
    hostKey: encodeBase64url(host.publicKey),
    credential,
    proof: machineCredentialProof({
      hostPrivateKey: (extra.proofHost ?? host).privateKey,
      exchangeKey,
      hostId: id,
      credential,
    }),
    ...(extra.sole ? { sole: true } : {}),
    ...(extra.ticket ? { ticket: extra.ticket } : {}),
  };
}

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 200;
  } catch (error) {
    if (error instanceof AceAccountError) return error.status;
    throw error;
  }
};

/** What a device grant minted with `token` is: its format, and a person's grant if one came. */
async function deviceGrant(token: string, host = hostId(keyPair().publicKey)) {
  const grant = await account().grant(
    token,
    { kind: "device", subject: "phone", host, key: P256_KEY },
    signal(),
  );
  const published = await keys();
  let format1 = true;
  try {
    verifyGrant(grant.token, published, Date.now(), "device");
  } catch {
    format1 = false;
  }
  const person = grant.standing
    ? verifyStandingGrant(grant.standing, published, Date.now())
    : undefined;
  return { grant, format1, person };
}

it("the person signing in in a browser gets a person's grant bound to its daemon and device key", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const host = hostId(keyPair().publicKey);
  const { format1, person: claims } = await deviceGrant(session.token, host);
  // Format 1 for older daemons, and the person's grant for this daemon and this key.
  expect(format1).toBe(true);
  expect(claims).toMatchObject({ standing: "person", host, key: P256_KEY, aud: "ace-daemon" });
  // Without naming a daemon and a key there is nothing to prove the person with.
  const bare = await account().grant(session.token, { kind: "device", subject: "phone" }, signal());
  expect(bare.standing).toBeUndefined();
});

it("an ace login session is a machine's from birth: no person's grant, and no format 1 device grant", async () => {
  const daemonSession = await signInThroughWorker(worker.http, workos, person, "machine");
  expect(await deviceGrant(daemonSession.token)).toMatchObject({
    format1: false,
    person: undefined,
  });
  // An older daemon starts its sign-in with no body and no return address: the same.
  const older = await signInThroughWorker(worker.http, workos, person, "legacy");
  expect(await deviceGrant(older.token)).toMatchObject({ format1: false, person: undefined });
});

it("a machine credential never gives person standing, older daemons never get a device grant from it, and it speaks only for its machine", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const host = keyPair();
  const credential = credentialToken();
  const issued = await account().machineCredential(
    session.token,
    await asMachine(host, credential),
    signal(),
  );
  expect(issued).toMatchObject({ token: credential, account: { id: "user_m" } });
  // Its device grant is format 2 with a machine's standing: an older daemon's format 1 parser
  // refuses it, so it never reaches one as the person.
  const { grant, format1, person: claims } = await deviceGrant(credential);
  expect(format1).toBe(false);
  expect(claims).toBeUndefined();
  expect(verifyStandingGrant(grant.token, await keys(), Date.now()).standing).toBe("machine");
  // Its market grants are a machine's, and it can't ask for a sensitive market request.
  const market = await account().grant(
    credential,
    { kind: "device", subject: "phone", purpose: "market-publish" },
    signal(),
  );
  expect(verifyMarketGrant(market.token, await keys(), Date.now(), "127.0.0.1").kind).toBe(
    "machine",
  );
  expect(
    await status(() =>
      account().grant(
        credential,
        {
          kind: "device",
          subject: "phone",
          purpose: "market-publish",
          action: "PUT /v1/me/handle",
        },
        signal(),
      ),
    ),
  ).toBe(403);
  // Machine grants for its own host only; it can't be traded on or change the account's list.
  const own = hostId(host.publicKey);
  const relayGrant = await account().grant(credential, { kind: "machine", subject: own }, signal());
  expect(verifyGrant(relayGrant.token, await keys(), Date.now(), "machine").subject).toBe(own);
  const other = hostId(keyPair().publicKey);
  expect(
    await status(() => account().grant(credential, { kind: "machine", subject: other }, signal())),
  ).toBe(403);
  const traded = await asMachine(keyPair(), credentialToken());
  expect(await status(() => account().machineCredential(credential, traded, signal()))).toBe(403);
  expect(await status(() => account().forgetMachine(credential, own, signal()))).toBe(403);
  // The app's session took nothing from the exchange: still the person's.
  expect((await deviceGrant(session.token)).person?.standing).toBe("person");
  await account().logout(session.token, signal());
  expect(await status(() => account().session(credential, signal()))).toBe(401);
});

it("a credential is issued only with the host key its host id names", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const host = keyPair();
  const forged = await asMachine(host, credentialToken(), { proofHost: keyPair() });
  expect(await status(() => account().machineCredential(session.token, forged, signal()))).toBe(
    403,
  );
  const claimed = {
    ...(await asMachine(keyPair(), credentialToken())),
    hostId: hostId(host.publicKey),
  };
  expect(await status(() => account().machineCredential(session.token, claimed, signal()))).toBe(
    403,
  );
});

it("an enrollment ticket signs in only its machine, once, and a lost answer is recovered by asking again", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const host = keyPair();
  const { ticket } = await account().machineEnrollment(
    session.token,
    hostId(host.publicKey),
    signal(),
  );
  const elsewhere = await asMachine(keyPair(), credentialToken(), { ticket });
  expect(await status(() => account().machineCredential(undefined, elsewhere, signal()))).toBe(403);
  const credential = credentialToken();
  const request = await asMachine(host, credential, { ticket });
  const first = await account().machineCredential(undefined, request, signal());
  // The answer went missing; the daemon asks again with the same credential and gets it.
  expect((await account().machineCredential(undefined, request, signal())).token).toBe(first.token);
  // A second credential from the spent ticket is refused.
  const second = await asMachine(host, credentialToken(), { ticket });
  expect(await status(() => account().machineCredential(undefined, second, signal()))).toBe(401);
  expect((await deviceGrant(credential)).format1).toBe(false);
  // The app's session is untouched by the ticket: still the person's.
  expect((await deviceGrant(session.token)).person?.standing).toBe("person");
});

it("a session exchanged by its only holder is retired in the same write, and two exchanges of it issue one credential", async () => {
  const session = await signInThroughWorker(worker.http, workos, person, "machine");
  const host = keyPair();
  const credential = credentialToken();
  const sole = await asMachine(host, credential, { sole: true });
  const rival = await asMachine(host, credentialToken(), { sole: true });
  const [one, two] = await Promise.all([
    status(() => account().machineCredential(session.token, sole, signal())),
    status(() => account().machineCredential(session.token, rival, signal())),
  ]);
  expect([one, two].filter((code) => code === 200)).toHaveLength(1);
  // Whoever copied the session file holds a dead token.
  expect(await status(() => account().session(session.token, signal()))).toBe(401);
  const issued = await worker.db
    .prepare("SELECT count(*) AS n FROM machine_credentials WHERE host_id = ?")
    .bind(hostId(host.publicKey))
    .first("n");
  expect(issued).toBe(1);
  // A sole exchange asked again after a lost answer still answers with its credential.
  if (one === 200)
    expect((await account().machineCredential(session.token, sole, signal())).token).toBe(
      credential,
    );
});

it("a session an older daemon keeps, or one from before standing was kept, never speaks for the person", async () => {
  const kept = await signInThroughWorker(worker.http, workos, person);
  await account().grant(
    kept.token,
    { kind: "machine", subject: hostId(keyPair().publicKey) },
    signal(),
  );
  expect(await deviceGrant(kept.token)).toMatchObject({ format1: false, person: undefined });
  const old = await signInThroughWorker(worker.http, workos, person);
  await worker.db
    .prepare("UPDATE sessions SET standing = 'legacy' WHERE standing = 'person'")
    .run();
  // Older apps still get format 1 for older daemons, but never a person's grant.
  expect(await deviceGrant(old.token)).toMatchObject({ format1: true, person: undefined });
});

it("an older daemon keeping its session still connects to the relay, and the relay admits a machine's format 2 device grant only for its daemon", async () => {
  const session = await signInThroughWorker(worker.http, workos, person, "legacy");
  const hostKeys = keyPair();
  const machine = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: {
      grant: async () =>
        (
          await account().grant(
            session.token,
            { kind: "machine", subject: hostId(hostKeys.publicKey) },
            signal(),
          )
        ).token,
      name: "Old box",
      platform: "linux",
    },
    onClientChannel: () => {},
  });
  try {
    expect((await account().machines(session.token, signal())).map((m) => m.name)).toContain(
      "Old box",
    );
  } finally {
    await machine.close();
  }
  // A format 2 device grant bound to one daemon opens only that daemon at the relay.
  const daemon = hostId(keyPair().publicKey);
  const bound = await account().grant(
    session.token,
    { kind: "device", subject: "phone", host: daemon },
    signal(),
  );
  const client = (host: string) => `${worker.relayUrl}/client?hostId=${host}`;
  // Its own daemon: admitted, then closed as offline (no such machine is connected).
  expect(await upgrade(client(daemon), [GRANT_SUBPROTOCOL_PREFIX + bound.token])).toMatchObject({
    code: 1008,
  });
  expect(
    await upgrade(client(hostId(keyPair().publicKey)), [GRANT_SUBPROTOCOL_PREFIX + bound.token]),
  ).toEqual({ status: 403 });
});
