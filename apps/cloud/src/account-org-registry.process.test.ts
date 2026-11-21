import { afterAll, beforeAll, expect, it } from "vitest";
import {
  GrantError,
  policyBodySha256,
  verifyMarketGrant,
  verifyMarketGrantSignature,
  verifyRegistryKeyAttestation,
} from "@ace/account-grant";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * What the account backend vouches for an organization's private registry (ADR 0206 §5.1,
 * §5.3), against the real Worker and D1, WorkOS faked at its HTTP edge: the member's role on a
 * market grant acting in the organization, and an owner's attestation of a registry key, which
 * grants nothing. Its own Worker: the Worker limits account requests per caller address.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let api: ReturnType<typeof orgCalls>;
const owner = workosUser("user_owner", "Olivia");
const mia = workosUser("user_mia", "Mia");
const zed = workosUser("user_zed", "Zed");
let org = "";
const tokens = new Map<string, string>();
const tokenOf = (user: typeof owner) => tokens.get(user.id) ?? "";

beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
  api = orgCalls(worker.http);
  for (const user of [owner, mia, zed])
    tokens.set(user.id, (await signInThroughWorker(worker.http, workos, user, "person")).token);
  org = await api.createOrg(tokenOf(owner), "Registry");
  workos.orgs.addMember(mia.id, org, "member");
  await worker.cron("* * * * *");
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

it("a market grant acting in an organization carries the role WorkOS gave, for its registry", async () => {
  const marketGrant = (token: string) =>
    api.call(token, "POST", "/v1/grants", {
      kind: "device",
      subject: "phone",
      purpose: "market-publish",
      org,
    });
  const keys = await api.keys();
  const claims = async (token: string) => {
    const answer = await marketGrant(token);
    expect(answer.status).toBe(200);
    return verifyMarketGrantSignature(String(answer.body.token), keys);
  };
  // The market lets an admin or owner publish to the registry and only an owner change its key
  // (ADR 0206 §5.1): it reads the role from here, minted from the same fresh WorkOS answer.
  expect(await claims(tokenOf(owner))).toMatchObject({ org, orgRole: "owner", account: owner.id });
  expect(await claims(tokenOf(mia))).toMatchObject({ org, orgRole: "member", account: mia.id });
  expect((await marketGrant(tokenOf(zed))).status).toBe(403);
});

it("only an owner gets the backend's attestation of a registry key, and it grants nothing", async () => {
  const upload = '{"statement":"a key upload, exactly as sent"}';
  const attest = (token: string) =>
    api.call(token, "POST", `/v1/orgs/${org}/registry/attestations`, {
      upload_sha256: policyBodySha256(upload),
    });
  const keys = await api.keys();
  const answer = await attest(tokenOf(owner));
  expect(answer.status).toBe(201);
  const attestation = String(answer.body.attestation);
  expect(verifyRegistryKeyAttestation(attestation, keys, upload)).toMatchObject({
    org,
    account: owner.id,
    role: "owner",
  });
  // For that upload only, and no grant parser takes it: kept in a public chain, it opens nothing.
  expect(() => verifyRegistryKeyAttestation(attestation, keys, `${upload} `)).toThrow(GrantError);
  expect(() => verifyMarketGrant(attestation, keys, Date.now())).toThrow(GrantError);
  expect(() => verifyMarketGrantSignature(attestation, keys)).toThrow(GrantError);
  // A member, or someone outside the organization, gets none.
  expect((await attest(tokenOf(mia))).status).toBe(403);
  expect((await attest(tokenOf(zed))).status).toBe(403);
});
