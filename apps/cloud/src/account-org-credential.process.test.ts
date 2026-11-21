import { afterAll, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX, encodeBase64url, verifyGrant } from "@ace/account-grant";
import { ORG_HOST_CREDENTIAL_SKEW_MS } from "@ace/account-grant/machine-proof";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import { hostId, keyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker, upgrade } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * An org host's organization credential (ADR 0206 §2.1) against the real Worker and D1, WorkOS
 * faked at its HTTP edge: issued once per enrollment with the host key, no person's session
 * behind it, so the host stays on the relay whatever becomes of the member who enrolled it;
 * renewed only with the host key while the organization holds the host; revoked on release; and
 * never anything that speaks for a person.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let api: ReturnType<typeof orgCalls>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
  api = orgCalls(worker.http);
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const credentialToken = () => encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
const session = (token: string) => api.call(token, "GET", "/v1/account/session");
const policy = (token: string, org: string) => api.call(token, "GET", `/v1/orgs/${org}/policy`);
const machineGrant = (token: string, subject: string) =>
  api.call(token, "POST", "/v1/grants", { kind: "machine", subject });

/**
 * An org owned by a fresh person, a member, and a machine that person signed in and gave the
 * org with its consent; `org` is its organization credential, issued at enrollment.
 */
async function enrolledHost(name: string) {
  const owner = workosUser(`user_${name.toLowerCase()}owner`, `${name}owner`);
  const member = workosUser(`user_${name.toLowerCase()}member`, `${name}member`);
  const ownerToken = (await signInThroughWorker(worker.http, workos, owner)).token;
  const org = await api.createOrg(ownerToken, name);
  workos.orgs.addMember(member.id, org, "member");
  await worker.cron("* * * * *");
  const daemonSession = (await signInThroughWorker(worker.http, workos, owner, "machine")).token;
  const box = await api.machine(worker.db, owner.id, daemonSession);
  const enrolled = await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id));
  if (enrolled.status !== 201) throw new Error(`Enrolling failed: ${enrolled.status}`);
  const credential = credentialToken();
  const issued = await api.orgCredential(box, org, credential);
  expect(issued.status).toBe(201);
  return { owner, member, ownerToken, daemonSession, org, box, credential, issued };
}

it("an org host stays on the relay after the member who enrolled it signs out and is deprovisioned", async () => {
  const { owner, member, ownerToken, daemonSession, org, box, credential, issued } =
    await enrolledHost("Stays");
  // It names the organization's own principal, never the person who enrolled it.
  expect(issued.body.account).toMatchObject({ id: `org:${org}`, name: "Stays" });

  // The enroller signs out everywhere, then the directory deprovisions them: WorkOS revokes
  // every session they had. Their own machine credential on the host dies with them.
  expect((await api.call(ownerToken, "DELETE", "/v1/account/session")).status).toBe(200);
  expect((await api.call(daemonSession, "DELETE", "/v1/account/session")).status).toBe(200);
  workos.revokeSessions(owner.id);
  expect((await session(box.credential)).status).toBe(401);

  // The organization's credential still reads, renews and speaks for its host.
  expect((await session(credential)).status).toBe(200);
  expect((await policy(credential, org)).status).toBe(200);
  expect((await api.orgCredential(box, org, credential)).status).toBe(200);
  const host = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys: box.host,
    limits: {},
    account: {
      grant: async () => String((await machineGrant(credential, box.hostId)).body.token),
      name: "Team box",
      platform: "linux",
    },
    onClientChannel: () => {},
  });
  try {
    const grant = await machineGrant(credential, box.hostId);
    expect(verifyGrant(String(grant.body.token), await api.keys(), Date.now(), "machine")).toEqual(
      expect.objectContaining({ account: `org:${org}`, subject: box.hostId }),
    );
    // A member still reaches it through the relay.
    const memberToken = (await signInThroughWorker(worker.http, workos, member)).token;
    const memberGrant = await api.memberGrant(memberToken, org, box.hostId);
    expect(memberGrant.status).toBe(200);
    const opened = await connectClientViaRelay({
      relayUrl: worker.relayUrl,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
      grant: String(memberGrant.body.token),
    });
    await opened.close();
  } finally {
    await host.close();
  }
});

it("only the host key issues or renews an organization credential, once per enrollment", async () => {
  const { org, box, credential } = await enrolledHost("Keyed");
  const before = await worker.db
    .prepare("SELECT expires FROM machine_credentials WHERE host_id = ? AND kind = 'org'")
    .bind(box.hostId)
    .first<{ expires: number }>();
  // Another key's proof, or a proof made too long ago, renews nothing.
  expect((await api.orgCredential(box, org, credential, { proofHost: keyPair() })).body).toEqual({
    error: "host_key",
  });
  const stale = Date.now() - ORG_HOST_CREDENTIAL_SKEW_MS - 60_000;
  expect((await api.orgCredential(box, org, credential, { at: stale })).body).toEqual({
    error: "host_key",
  });
  // The credential alone, without the host key's proof, is no request.
  expect(
    (await api.call(credential, "POST", `/v1/orgs/${org}/hosts/${box.hostId}/credential`, {}))
      .status,
  ).toBe(400);
  const after = await worker.db
    .prepare("SELECT expires FROM machine_credentials WHERE host_id = ? AND kind = 'org'")
    .bind(box.hostId)
    .first<{ expires: number }>();
  expect(after?.expires).toBe(before?.expires);
  // With the host key it renews.
  const renewed = await api.orgCredential(box, org, credential);
  expect(renewed.status).toBe(200);
  expect(Number(renewed.body.expiresAt)).toBeGreaterThanOrEqual(before?.expires ?? 0);
  // One per enrollment: a second credential for it is refused, and so is another org's.
  expect((await api.orgCredential(box, org, credentialToken())).body).toEqual({
    error: "credential_issued",
  });
  const other = await api.createOrg(
    (await signInThroughWorker(worker.http, workos, workosUser("user_keyedzed", "Zed"))).token,
    "Elsewhere",
  );
  expect((await api.orgCredential(box, other, credentialToken())).body).toEqual({
    error: "not_org_host",
  });
});

it("releasing the host revokes its organization credential: it can't renew, read policy or reach the relay", async () => {
  const { ownerToken, org, box, credential } = await enrolledHost("Freed");
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/hosts/${box.hostId}`)).status).toBe(
    200,
  );
  expect((await session(credential)).status).toBe(401);
  expect((await policy(credential, org)).status).toBe(401);
  expect((await machineGrant(credential, box.hostId)).status).toBe(401);
  expect((await api.orgCredential(box, org, credential)).body).toEqual({ error: "not_org_host" });

  // Given to the organization again, the earlier enrollment's credential still speaks for
  // nothing: the new enrollment gets a credential of its own.
  const again = await api.enroll(
    ownerToken,
    org,
    box,
    await api.consent(box, org, "user_freedowner"),
  );
  expect(again.status).toBe(201);
  expect((await policy(credential, org)).status).toBe(401);
  const next = credentialToken();
  expect((await api.orgCredential(box, org, next)).status).toBe(201);
  expect((await policy(next, org)).status).toBe(200);
  expect((await session(credential)).status).toBe(401);
});

it("an organization credential never speaks for a person", async () => {
  const { owner, org, box, credential } = await enrolledHost("Nobody");
  const grant = (body: Record<string, unknown>) => api.call(credential, "POST", "/v1/grants", body);
  const key = encodeBase64url(new Uint8Array(65).fill(4));
  // No member grant, no device grant in either format, no Spade Cloud or market grant.
  expect((await grant({ kind: "member", org, host: box.hostId, subject: "p", key })).body).toEqual({
    error: "person_required",
  });
  for (const body of [
    { kind: "device", subject: "phone" },
    { kind: "device", subject: "phone", host: box.hostId, key },
    { kind: "machine", subject: box.hostId, purpose: "spade-cloud" },
    { kind: "machine", subject: box.hostId, purpose: "market-publish" },
  ])
    expect((await grant(body)).body).toEqual({ error: "org_credential" });
  // No other host's machine grant, and the one it gets names the organization, not the enroller.
  expect((await machineGrant(credential, hostId(keyPair().publicKey))).status).toBe(403);
  const own = await machineGrant(credential, box.hostId);
  const claims = verifyGrant(String(own.body.token), await api.keys(), Date.now(), "machine");
  expect(claims.account).toBe(`org:${org}`);
  expect(claims.account).not.toBe(owner.id);
  // Nothing the person does in the organization: no org routes, no enrollment tickets.
  expect((await api.call(credential, "GET", `/v1/orgs/${org}/members`)).body).toEqual({
    error: "person_required",
  });
  expect(
    (await api.call(credential, "POST", "/v1/machine-enrollments", { hostId: box.hostId })).status,
  ).toBe(403);
  // At the relay, its grant opens no person's device to anything but its own host.
  expect(
    await upgrade(`${worker.relayUrl}/client?hostId=${box.hostId}`, [
      GRANT_SUBPROTOCOL_PREFIX + String(own.body.token),
    ]),
  ).toEqual({ status: 401 });
});
