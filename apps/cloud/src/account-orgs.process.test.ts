import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyMemberGrant } from "@ace/account-grant";
import { AceLogin } from "@ace/protocol/ace-account";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { continueSignIn, signInThroughWorker } from "./testing/sign-in.ts";
import { allowedOrigin, publicUrl } from "./testing/worker.ts";

/*
 * Organizations on WorkOS (ADR 0206) against the real Worker and D1 under Miniflare, with WorkOS
 * faked at its HTTP edge: creating an organization, inviting and joining, changing roles and
 * removing a member. WorkOS stays the authority; the mirror follows it.
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

const owner = workosUser("user_owner", "Olivia");
const mia = workosUser("user_mia", "Mia");
const ada = workosUser("user_ada", "Ada");
const signIn = async (user = owner, holder: "person" | "machine" = "person") =>
  (await signInThroughWorker(worker.http, workos, user, holder)).token;
const events = () => worker.cron("* * * * *");

it("a person with a verified email creates an organization, owns it, and sees it as a space", async () => {
  const token = await signIn();
  const org = await api.createOrg(token, "Acme");
  expect(workos.orgs.membership(owner.id, org)).toMatchObject({
    status: "active",
    role: { slug: "owner" },
  });
  expect((await api.call(token, "GET", "/v1/orgs")).body.orgs).toEqual([
    { id: org, name: "Acme", role: "owner", plan: "pilot", directoryManaged: false },
  ]);

  // An unverified email can't make one, and neither can a session a machine keeps.
  const unverified = await signIn(workosUser("user_unverified", "Una", false));
  expect((await api.call(unverified, "POST", "/v1/orgs", { name: "Nope" })).status).toBe(403);
  const daemon = await signIn(owner, "machine");
  expect((await api.call(daemon, "POST", "/v1/orgs", { name: "Nope" })).body).toEqual({
    error: "person_required",
  });
});

it("an invitation link shows who invited whom to what, spends nothing, and its button joins", async () => {
  const token = await signIn();
  const org = await api.createOrg(token, "Acme <Labs>");
  const sent = await api.call(token, "POST", `/v1/orgs/${org}/invitations`, {
    email: mia.email,
    role: "member",
  });
  expect(sent).toMatchObject({ status: 201, body: { email: mia.email, state: "pending" } });
  const invitation = workos.orgs.invitations().find((each) => each.id === sent.body.id);
  expect(invitation).toMatchObject({ organization_id: org, inviter_user_id: owner.id });
  const link = `${worker.http}/v1/orgs/join?invitation_token=${invitation?.token}`;

  // Previews and preloaders may fetch it any number of times.
  for (let fetches = 0; fetches < 2; fetches++) {
    const shown = await fetch(link);
    const html = await shown.text();
    expect(shown.status).toBe(200);
    expect(html).toContain("Olivia invited you to join Acme &lt;Labs&gt;");
    expect(html).not.toContain("<Labs>");
    expect(html).toContain('action="/v1/orgs/join"');
  }
  expect(invitation?.state).toBe("pending");
  expect((await fetch(`${worker.http}/v1/orgs/join?invitation_token=nope`)).status).toBe(410);

  const sessionsBefore = await worker.db
    .prepare("SELECT count(*) AS n FROM sessions")
    .first<{ n: number }>();
  // Only the backend's own page may post the button.
  const elsewhere = await fetch(`${worker.http}/v1/orgs/join`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ invitation_token: invitation?.token ?? "" }),
  });
  expect(elsewhere.status).toBe(403);
  const joined = await fetch(`${worker.http}/v1/orgs/join`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: publicUrl, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ invitation_token: invitation?.token ?? "" }),
  });
  expect(joined.status).toBe(302);
  const authorizeUrl = joined.headers.get("location") ?? "";
  expect(new URL(authorizeUrl).searchParams.get("invitation_token")).toBe(invitation?.token);
  const state = workos.authorize(authorizeUrl, mia, "join-code");
  const callback = await fetch(`${worker.http}/v1/account/callback?state=${state}&code=join-code`, {
    headers: { cookie: joined.headers.get("set-cookie")?.split(";")[0] ?? "" },
  });
  expect(callback.status).toBe(200);
  expect(await callback.text()).toContain("You've joined");
  // Nobody waits for that sign-in's session, so none was kept.
  const sessionsAfter = await worker.db
    .prepare("SELECT count(*) AS n FROM sessions")
    .first<{ n: number }>();
  expect(sessionsAfter?.n).toBe(sessionsBefore?.n);

  // Mia's own app sees the new space at once, before the events cron runs.
  const miaToken = await signIn(mia);
  expect((await api.call(miaToken, "GET", "/v1/orgs")).body.orgs).toEqual([
    expect.objectContaining({ id: org, role: "member" }),
  ]);
});

it("an admin changes roles; a member can't; only owners touch owners; the last owner stays", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Roles");
  workos.orgs.addMember(mia.id, org, "member");
  workos.orgs.addMember(ada.id, org, "admin");
  await events();
  const miaToken = await signIn(mia);
  const adaToken = await signIn(ada);
  const role = (token: string, account: string, value: string) =>
    api.call(token, "PATCH", `/v1/orgs/${org}/members/${account}`, { role: value });

  expect((await role(miaToken, ada.id, "member")).body).toEqual({ error: "forbidden" });
  expect((await role(adaToken, mia.id, "admin")).status).toBe(200);
  expect(workos.orgs.membership(mia.id, org)?.role.slug).toBe("admin");
  const members = await api.call(adaToken, "GET", `/v1/orgs/${org}/members`);
  expect(members.body.members).toContainEqual(
    expect.objectContaining({ account: mia.id, role: "admin", status: "active" }),
  );
  // Making or unmaking an owner is an owner's.
  expect((await role(adaToken, mia.id, "owner")).status).toBe(403);
  expect((await role(adaToken, owner.id, "member")).status).toBe(403);
  // The organization never has no owner.
  expect((await role(ownerToken, owner.id, "admin")).body).toEqual({ error: "last_owner" });
  const leaving = await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${owner.id}`);
  expect(leaving.body).toEqual({ error: "last_owner" });
  expect((await role(ownerToken, mia.id, "owner")).status).toBe(200);
  expect((await role(ownerToken, owner.id, "admin")).status).toBe(200);
});

it("Remove deletes the membership, ends the person's org grants and portal sessions, and leaves their personal space", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Removal");
  workos.orgs.addMember(mia.id, org, "admin");
  await events();
  const machineSession = await signIn(owner, "machine");
  const box = await api.machine(worker.db, owner.id, machineSession);
  expect(
    (await api.call(ownerToken, "POST", `/v1/orgs/${org}/hosts`, { hostId: box.hostId })).status,
  ).toBe(201);

  const miaToken = await signIn(mia);
  const granted = await api.memberGrant(miaToken, org, box.hostId);
  expect(granted.status).toBe(200);
  expect(verifyMemberGrant(String(granted.body.token), await api.keys(), Date.now())).toMatchObject(
    {
      org,
      role: "admin",
      account: mia.id,
      host: box.hostId,
      policy: 0,
    },
  );
  // An Admin Portal link names the admin who asked for it.
  const portal = await api.call(miaToken, "POST", `/v1/orgs/${org}/portal`, { intent: "sso" });
  expect(portal.status).toBe(200);
  expect(workos.orgs.portalLinks().at(-1)).toEqual({
    organization: org,
    intent: "sso",
    external_user_id: mia.id,
  });

  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  // Deleted at WorkOS, never deactivated: deactivating would sign Mia out of everything.
  expect(workos.orgs.membership(mia.id, org)).toBeUndefined();
  expect(workos.orgs.portalRevocations()).toContainEqual({
    organization: org,
    external_user_id: mia.id,
  });
  expect(
    (await api.call(ownerToken, "GET", `/v1/orgs/${org}/members`)).body.members,
  ).not.toContainEqual(expect.objectContaining({ account: mia.id }));
  expect((await api.memberGrant(miaToken, org, box.hostId)).body).toEqual({ error: "not_member" });
  expect((await api.call(miaToken, "GET", "/v1/orgs")).body.orgs).not.toContainEqual(
    expect.objectContaining({ id: org }),
  );
  // Mia's own account goes on as before.
  expect((await api.call(miaToken, "GET", "/v1/account/session")).status).toBe(200);
  const personal = await api.call(miaToken, "POST", "/v1/grants", {
    kind: "device",
    subject: "phone",
  });
  expect(personal.status).toBe(200);
});

it("a sign-in started for an organization asks WorkOS to apply that organization's sign-in policy", async () => {
  const started = await fetch(`${worker.http}/v1/account/login`, {
    method: "POST",
    headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ holder: "person", org: "org_01ACME" }),
  });
  const flow = AceLogin.parse(await started.json());
  const { authorizeUrl } = await continueSignIn(worker.http, flow.loginUrl);
  expect(new URL(authorizeUrl).searchParams.get("organization_id")).toBe("org_01ACME");
});
