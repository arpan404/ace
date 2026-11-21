import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * Admin Portal sessions of people who may no longer open them (ADR 0206 §6), against the real
 * Worker and D1, WorkOS faked at its HTTP edge: every removal and deactivation revokes them,
 * whatever the mirror knew; a revocation WorkOS fails is retried by the cron; and a link being
 * issued as its admin is removed is revoked once it exists. The revocation queue and the lease
 * between issuing and revoking live in D1 across requests and cron runs, so they're tested here.
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
/** One session per person for the whole file: the Worker rate-limits sign-ins. */
const sessions = new Map<string, Promise<string>>();
function signIn(user = owner): Promise<string> {
  let session = sessions.get(user.id);
  if (!session) {
    session = signInThroughWorker(worker.http, workos, user).then((grant) => grant.token);
    sessions.set(user.id, session);
  }
  return session;
}
const events = () => worker.cron("* * * * *");
const portal = (token: string, org: string) =>
  api.call(token, "POST", `/v1/orgs/${org}/portal`, { intent: "sso" });
/** What WorkOS did with this admin's portal links, in order. */
const portalLog = (org: string, account: string) =>
  workos.orgs
    .portalLog()
    .filter((each) => each.organization === org && each.external_user_id === account)
    .map((each) => each.kind);

it("Remove revokes an admin's portal sessions the mirror didn't know of, and retries a revocation WorkOS failed", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Portal remove");
  workos.orgs.addMember(mia.id, org, "member");
  await events();
  // WorkOS made Mia an admin; the mirror hasn't heard yet.
  workos.orgs.setRole(mia.id, org, "admin");
  const miaToken = await signIn(mia);
  expect((await portal(miaToken, org)).status).toBe(200);

  workos.failNext(({ path }) => path === "/portal/revoke_link");
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  expect(portalLog(org, mia.id)).toEqual(["link"]);
  await events();
  expect(portalLog(org, mia.id)).toEqual(["link", "revoke"]);
  // Done once WorkOS confirmed it: the next run asks nothing more.
  await events();
  expect(portalLog(org, mia.id)).toEqual(["link", "revoke"]);
});

it("the directory deactivating an admin revokes their portal sessions at the next events run", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Portal directory");
  workos.orgs.addMember(ada.id, org, "admin");
  await events();
  expect((await portal(await signIn(ada), org)).status).toBe(200);

  workos.orgs.deactivate(ada.id, org);
  await events();
  expect(portalLog(org, ada.id)).toEqual(["link", "revoke"]);
});

it("a link being issued as its admin is removed is revoked once it exists", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Portal race");
  workos.orgs.addMember(mia.id, org, "admin");
  await events();
  const miaToken = await signIn(mia);
  // Make Mia's check fresh, so her link request goes straight to WorkOS.
  expect((await api.call(miaToken, "GET", `/v1/orgs/${org}/members`)).status).toBe(200);

  const held = workos.holdNext(({ path }) => path === "/portal/generate_link", "before");
  const linking = portal(miaToken, org);
  await held.started;
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  // The cron sees WorkOS's deletion event while the link is still being made.
  await events();
  held.release();
  await linking;
  await events();
  // Whatever order the requests ran in, the last word on Mia's links is a revocation.
  expect(portalLog(org, mia.id).at(-1)).toBe("revoke");
  expect(portalLog(org, mia.id)).toContain("link");
  // And she gets no new one.
  expect((await portal(miaToken, org)).status).toBe(403);
});
