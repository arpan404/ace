import { expect, it } from "vitest";
import { GrantKeySet, verifyGrant } from "@ace/account-grant";
import {
  deviceKey,
  person,
  signal,
  stored,
  useAccountBackend,
} from "./machine-standing-test-support.ts";
import { helloWith, mia, orgTeamHost } from "./org-host-test-support.ts";

// ADR 0206 §2.1: an org host's organization credential, end to end with a real daemon on ace's
// account backend (the Worker and D1 under Miniflare, a fake WorkOS). Once the daemon takes in
// its enrollment it signs in as the organization, so the member who enrolled it can leave.
// A file of its own: the Worker's per-address request budget is shared by a file's tests.

const backend = useAccountBackend();

it("an org host stays signed in as its organization after the member who enrolled it signs out and is deprovisioned", async () => {
  const { home, org, miaToken, memberGrant, api } = await orgTeamHost(backend);
  // Confirming the enrollment took in the organization's own credential: no session of Pat's
  // is behind the host's sign-in now.
  expect(home.account.status()).toMatchObject({ signedIn: true, account: { id: `org:${org}` } });
  expect(await stored(home.home)).toMatchObject({ source: "org", org, kind: "machine" });

  // Pat signs out, then the directory deprovisions them: WorkOS revokes every session they had.
  expect((await api.call(home.session.token, "DELETE", "/v1/account/session")).status).toBe(200);
  backend.workos.revokeSessions(person.id);

  // The host renews with its key and keeps its relay grant, which names the organization.
  await home.account.renew();
  expect(home.account.status()).toMatchObject({ signedIn: true, account: { id: `org:${org}` } });
  const keys = GrantKeySet.parse(await (await fetch(`${backend.worker.http}/v1/keys`)).json());
  const grant = await home.account.machineGrant(home.host, signal());
  expect(verifyGrant(grant, keys, Date.now(), "machine")).toMatchObject({
    account: `org:${org}`,
    subject: home.host,
  });
  // Its members still come in and prove their standing.
  const key = await deviceKey();
  const admitted = await helloWith(home, (await memberGrant(miaToken, key.raw)).token);
  expect(admitted.refused).toBeUndefined();
  // And a person's sign-in can't take the organization's place.
  await expect(
    home.account.handover(backend.worker.http, { token: home.session.token }),
  ).rejects.toMatchObject({ status: 409 });

  // Released at the backend by an owner: the next renewal signs it out.
  backend.workos.orgs.setRole(mia.id, org, "owner");
  await backend.worker.events();
  expect((await api.call(miaToken, "DELETE", `/v1/orgs/${org}/hosts/${home.host}`)).status).toBe(
    200,
  );
  await home.account.renew();
  expect(home.account.status().signedIn).toBe(false);
  await home.close();
});
