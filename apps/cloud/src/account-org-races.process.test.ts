import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyMemberGrant } from "@ace/account-grant";
import { digest, sealer } from "./account/crypto.ts";
import { sessionReader } from "./account/session.ts";
import { sessionStore } from "./account/sessions.ts";
import { InvalidGrantError } from "./account/workos.ts";
import type { AccountIdentity } from "./account/workos.ts";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { FakeRequest } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * Organizations under concurrency (ADR 0206 §1.4, §1.2, §6), against the real Worker and D1,
 * WorkOS faked at its HTTP edge and held mid-request to force each interleaving: refreshes that
 * share one single-use refresh token, a demotion while WorkOS is still answering, two owners
 * leaving at once, and two events cron runs at once. Only real D1 writes from concurrent
 * requests show whether the guards hold, which a unit test of the pure logic can't.
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
/** One session per person and holder for the whole file: the Worker rate-limits sign-ins. */
const sessions = new Map<string, Promise<string>>();
function signIn(user = owner, holder: "person" | "machine" = "person"): Promise<string> {
  const key = `${user.id}:${holder}`;
  let session = sessions.get(key);
  if (!session) {
    session = signInThroughWorker(worker.http, workos, user, holder).then((grant) => grant.token);
    sessions.set(key, session);
  }
  return session;
}
const events = () => worker.cron("* * * * *");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Where the events cron stands in WorkOS's feed. */
const cursor = async () =>
  (
    await worker.db
      .prepare("SELECT after FROM workos_events WHERE feed = 'members'")
      .first<{ after: string }>()
  )?.after;
const refreshInto =
  (org: string) =>
  ({ path, body }: FakeRequest) =>
    path === "/user_management/authenticate" &&
    body.grant_type === "refresh_token" &&
    body.organization_id === org;

it("two refreshes of one session at once spend each refresh token once, and both stand", async () => {
  const token = await signInThroughWorker(worker.http, workos, owner).then((grant) => grant.token);
  const first = await api.createOrg(token, "Lease one");
  const second = await api.createOrg(token, "Lease two");
  const reusedBefore = workos.reusedRefreshTokens();

  // The first org check holds the session's refresh lease while WorkOS answers; the second asks
  // for another organization meanwhile, so it waits for that lease.
  const held = workos.holdNext(refreshInto(first));
  const firstCall = api.call(token, "GET", `/v1/orgs/${first}/members`);
  await held.started;
  const secondCall = api.call(token, "GET", `/v1/orgs/${second}/members`);
  await pause(400);
  held.release();

  expect((await firstCall).status).toBe(200);
  expect((await secondCall).status).toBe(200);
  // The waiting one spent the token the first one stored, never the one the first one spent.
  expect(workos.reusedRefreshTokens()).toBe(reusedBefore);
  expect((await api.call(token, "GET", "/v1/account/session")).status).toBe(200);
});

/** A session in D1 and WorkOS's single-use refresh tokens for it, read by two isolates. */
async function personalSession() {
  const account = { id: "user_lease", email: "lease@example.com", name: "Lease" };
  let leases = 0;
  const store = sessionStore(
    worker.db,
    sealer("cd".repeat(32), (length) => crypto.getRandomValues(new Uint8Array(length))),
    () => `lease-${++leases}`,
  );
  const hash = await digest(`session-${crypto.randomUUID()}`);
  await store.put(hash, account, "refresh-0", Date.now() + 86_400_000, Date.now(), "person");
  const live = new Set(["refresh-0"]);
  let issued = 0;
  let reused = 0;
  /** WorkOS at its edge: each refresh token works once. `before` runs first, as a slow network would. */
  const provider = (before: () => Promise<void> = async () => {}) => ({
    async refresh(refreshToken: string): Promise<AccountIdentity> {
      await before();
      if (!live.delete(refreshToken)) {
        reused++;
        throw new InvalidGrantError("WorkOS rejected the grant");
      }
      const next = `refresh-${++issued}`;
      live.add(next);
      return { account, refreshToken: next };
    },
  });
  return { account, store, hash, provider, reused: () => reused };
}

it("a personal refresh that waited for the lease reads the token the refresh before it stored", async () => {
  const { account, store, hash, provider, reused } = await personalSession();
  // Two isolates, each with its own in-flight refreshes; one reaches D1 a moment late.
  const late = Promise.withResolvers<void>();
  const slow = sessionReader({
    store: {
      ...store,
      lease: async (...args) => {
        await late.promise;
        return store.lease(...args);
      },
    },
    provider: provider(),
    now: () => Date.now(),
  });
  const fast = sessionReader({ store, provider: provider(), now: () => Date.now() });

  const slowRead = slow.readHash(hash);
  await pause(50);
  expect(await fast.readHash(hash)).toMatchObject({ account });
  late.resolve();
  expect(await slowRead).toMatchObject({ account });
  expect(reused()).toBe(0);
  expect(await store.get(hash, Date.now())).toBeDefined();
});

it("a refresh whose lease ran out never ends the session a later lease's holder renewed", async () => {
  const { account, store, hash, provider } = await personalSession();
  const start = Date.now();
  // WorkOS takes the first reader's request last: by then its lease has run out.
  const slowAtWorkos = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const first = sessionReader({
    store,
    provider: provider(async () => {
      reached.resolve();
      await slowAtWorkos.promise;
    }),
    now: () => start,
  });
  const second = sessionReader({ store, provider: provider(), now: () => start + 16_000 });

  const firstRead = first.readHash(hash);
  await reached.promise;
  expect(await second.readHash(hash)).toMatchObject({ account });
  slowAtWorkos.resolve();
  // WorkOS refuses the token the second reader already spent; the session stays.
  expect(await firstRead).toMatchObject({ account });
  expect(await store.get(hash, start + 16_000)).toBeDefined();
});

it("a demotion while WorkOS is still answering never yields a grant with the role it took away", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Demoted");
  workos.orgs.addMember(mia.id, org, "admin");
  await events();
  const box = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  expect(
    (await api.call(ownerToken, "POST", `/v1/orgs/${org}/hosts`, { hostId: box.hostId })).status,
  ).toBe(201);
  const miaToken = await signIn(mia);

  // WorkOS has answered "admin" for Mia's check, but the answer is still on its way.
  const held = workos.holdNext(refreshInto(org));
  const granting = api.memberGrant(miaToken, org, box.hostId);
  await held.started;
  const demoted = await api.call(ownerToken, "PATCH", `/v1/orgs/${org}/members/${mia.id}`, {
    role: "member",
  });
  expect(demoted.status).toBe(200);
  held.release();

  const granted = await granting;
  expect(granted.status).toBe(200);
  expect(verifyMemberGrant(String(granted.body.token), await api.keys(), Date.now())).toMatchObject(
    { org, account: mia.id, role: "member" },
  );
  // Nor does a later request reuse the earlier answer.
  const again = await api.memberGrant(miaToken, org, box.hostId);
  expect(verifyMemberGrant(String(again.body.token), await api.keys(), Date.now()).role).toBe(
    "member",
  );
});

it.each(["before", "after"] as const)(
  "two owners leaving at once (WorkOS slow %s acting on the first): one leaves, the other is the last owner and stays",
  async (when) => {
    const ownerToken = await signIn();
    const org = await api.createOrg(ownerToken, `Two owners ${when}`);
    workos.orgs.addMember(ada.id, org, "owner");
    await events();
    const adaToken = await signIn(ada);
    const members = `/v1/orgs/${org}/members`;
    expect((await api.call(adaToken, "GET", members)).status).toBe(200);

    // Olivia's leave is at WorkOS; Ada leaves before Olivia's answer comes back.
    const held = workos.holdNext(
      ({ method, path }) =>
        method === "DELETE" && path.startsWith("/user_management/organization_memberships/"),
      when,
    );
    const olivia = api.call(ownerToken, "DELETE", `${members}/${owner.id}`);
    await held.started;
    const adaLeaving = api.call(adaToken, "DELETE", `${members}/${ada.id}`);
    await pause(400);
    held.release();

    expect((await olivia).status).toBe(200);
    expect((await adaLeaving).body).toEqual({ error: "last_owner" });
    expect(workos.orgs.membership(ada.id, org)).toMatchObject({
      status: "active",
      role: { slug: "owner" },
    });
    expect(workos.orgs.membership(owner.id, org)).toBeUndefined();
  },
);

it("an owner WorkOS demoted but the mirror still counts doesn't let the last owner leave", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Stale owners");
  workos.orgs.addMember(ada.id, org, "owner");
  await events();
  // The WorkOS dashboard makes Ada a member; the events cron hasn't run.
  workos.orgs.setRole(ada.id, org, "member");
  const leaving = await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${owner.id}`);
  expect(leaving.body).toEqual({ error: "last_owner" });
  expect(workos.orgs.membership(owner.id, org)).toMatchObject({ role: { slug: "owner" } });
});

it("a slow events run never moves the cursor back nor puts older details over newer ones", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Feed race");
  const bob = workosUser("user_bob", "Bob");
  workos.orgs.knowUser(bob);
  workos.orgs.addMember(bob.id, org, "member");
  await events();
  const bobsName = async () =>
    (
      (await api.call(ownerToken, "GET", `/v1/orgs/${org}/members`)).body.members as {
        account: string;
        name?: string;
      }[]
    ).find((each) => each.account === bob.id)?.name;

  workos.orgs.renameUser(bob.id, "Robert");
  // The slow run has its page (Robert) but hasn't applied it.
  const slowPage = workos.holdNext(({ path }) => path === "/events");
  const slowRun = events();
  await slowPage.started;
  workos.orgs.renameUser(bob.id, "Bobby");
  await events();
  const latest = workos.orgs.events().at(-1)?.id;
  expect(await cursor()).toBe(latest);
  slowPage.release();
  await slowRun;

  expect(await cursor()).toBe(latest);
  expect(await bobsName()).toBe("Bobby");
});
