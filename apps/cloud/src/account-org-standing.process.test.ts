import { expect, it } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import { workosUser } from "./testing/org-calls.ts";
import { useDirectoryWorld } from "./testing/org-directory-world.ts";

/*
 * `POST /v1/grants/standing` (ADR 0206 §6, §8.1) on the real Worker: an org host about to stamp
 * a member's answer, or the market about to serve an org grant, asks whether the grant still
 * speaks for its member.
 */

/** The market's own token for this route, a secret both Workers hold. */
const MARKET = "market_standing_token_for_tests_0123456789a";
const world = useDirectoryWorld({ vars: { ACE_MARKET_STANDING_TOKEN: MARKET } });
const { deliver, lastEvent, team } = world;

/** Asks about `grant` as `caller` (the market by default; null: nobody). */
const ask = (grant: string, caller: string | null = MARKET) =>
  world.api.call(caller ?? undefined, "POST", "/v1/grants/standing", { grant });
/** A member's grant for the org's host and an org market grant, as the backend mints them. */
async function grantsOf(token: string, org: string, hostId: string) {
  const member = String((await world.api.memberGrant(token, org, hostId)).body.token);
  const market = String(
    (
      await world.api.call(token, "POST", "/v1/grants", {
        kind: "device",
        subject: "phone",
        purpose: "market-publish",
        org,
      })
    ).body.token,
  );
  return { member, market };
}
const credentialToken = () => encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));

it("a host or the market asking about a member's grant hears it's current only while WorkOS and the mirror still say so", async () => {
  const gus = workosUser("user_gus", "Gus");
  const { org, box, token } = await team("Standing", gus);
  const member = String((await world.api.memberGrant(token, org, box.hostId)).body.token);
  const market = String(
    (
      await world.api.call(token, "POST", "/v1/grants", {
        kind: "device",
        subject: "phone",
        purpose: "market-publish",
        org,
      })
    ).body.token,
  );
  const standing = (grant: string) => ask(grant);
  for (const grant of [member, market])
    expect((await standing(grant)).body).toEqual({ current: true, role: "member" });

  // WorkOS can't be asked: no answer, never a stale yes.
  world.workos.failNext(
    (request) => request.path.startsWith("/user_management/organization_memberships"),
    503,
  );
  expect((await standing(member)).status).toBe(503);
  // Not a grant the backend signed.
  expect((await standing("not-a-grant")).status).toBe(400);

  // The directory makes him an admin: a grant carrying his old role is no longer current.
  world.workos.orgs.setRole(gus.id, org, "admin");
  expect(await deliver(lastEvent())).toBe(200);
  for (const grant of [member, market])
    expect((await standing(grant)).body).toEqual({ current: false });
  // Deactivated: nothing he holds is current.
  world.workos.orgs.deactivate(gus.id, org);
  expect(await deliver(lastEvent())).toBe(200);
  expect((await standing(market)).body).toEqual({ current: false });
});

it("a removal that lands while WorkOS answers makes the answer not current", async () => {
  const ida = workosUser("user_ida", "Ida");
  const { org, box, token } = await team("Raced", ida);
  const { member } = await grantsOf(token, org, box.hostId);
  const held = world.workos.holdNext(
    (request) => request.path.startsWith("/user_management/organization_memberships"),
    "after",
  );
  const asking = ask(member);
  await held.started;
  world.workos.orgs.deactivate(ida.id, org);
  expect(await deliver(lastEvent())).toBe(200);
  held.release();
  expect((await asking).body).toEqual({ current: false });
});

it("answers only the market, or an org host for its own organization, about a bounded body", async () => {
  const jo = workosUser("user_jo", "Jo");
  const { org, box, token } = await team("Callers", jo);
  const { member } = await grantsOf(token, org, box.hostId);
  // The org's host, signed in with its organization credential.
  const host = credentialToken();
  expect((await world.api.orgCredential(box, org, host)).status).toBe(201);
  expect((await ask(member, host)).body).toEqual({ current: true, role: "member" });
  // No caller, a wrong market token, and a person's own machine are all refused.
  expect((await ask(member, null)).status).toBe(401);
  expect((await ask(member, "not_the_market_token_at_all_0123456789abcde")).status).toBe(401);
  const personal = await world.api.machine(
    world.worker.db,
    world.owner.id,
    await world.signIn(world.owner, "machine"),
  );
  expect((await ask(member, personal.credential)).status).toBe(403);
  // A host speaks only about its own organization's grants.
  const other = await team("Elsewhere", workosUser("user_kim", "Kim"));
  const { member: theirs } = await grantsOf(other.token, other.org, other.box.hostId);
  expect((await ask(theirs, host)).status).toBe(403);
  // A body past the route's small limit isn't read.
  const huge = await fetch(`${world.worker.http}/v1/grants/standing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MARKET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ grant: "x".repeat(64 * 1024) }),
  });
  expect(huge.status).toBe(413);
});

it("asks WorkOS about only a few grants at once", async () => {
  const lu = workosUser("user_lu", "Lu");
  const { org, box, token } = await team("Busy", lu);
  const { member } = await grantsOf(token, org, box.hostId);
  const lookup = (request: { path: string }) =>
    request.path.startsWith("/user_management/organization_memberships");
  const holds = [1, 2, 3, 4].map(() => world.workos.holdNext(lookup, "before"));
  const asking = holds.map(() => ask(member));
  await Promise.all(holds.map((each) => each.started));
  // A fifth while four wait on WorkOS: refused at once, WorkOS not asked.
  expect((await ask(member)).status).toBe(503);
  for (const each of holds) each.release();
  for (const each of await Promise.all(asking))
    expect(each.body).toEqual({ current: true, role: "member" });
});

it("throttles callers that don't authenticate by their address", async () => {
  const answers = [];
  for (let request = 0; request < 130; request++) answers.push((await ask("x", null)).status);
  expect(answers).toContain(429);
});
