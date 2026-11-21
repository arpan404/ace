import { expect, it } from "vitest";
import { workosUser } from "./testing/org-calls.ts";
import { useDirectoryWorld } from "./testing/org-directory-world.ts";

/*
 * `POST /v1/grants/standing` (ADR 0206 §6, §8.1) on the real Worker: an org host about to stamp
 * a member's answer, or the market about to serve an org grant, asks whether the grant still
 * speaks for its member.
 */

const world = useDirectoryWorld();
const { deliver, lastEvent, team } = world;

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
  const standing = (grant: string) =>
    world.api.call(undefined, "POST", "/v1/grants/standing", { grant });
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
