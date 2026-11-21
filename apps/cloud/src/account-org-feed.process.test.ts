import { expect, it } from "vitest";
import { workosUser } from "./testing/org-calls.ts";
import { useDirectoryWorld, type Delivery } from "./testing/org-directory-world.ts";

/*
 * The members mirror against WorkOS's feed and webhook as they really arrive (ADR 0206 §6,
 * amendment 1): deletions that come before what they delete, users deleted on the page that
 * made their membership, deliveries that overlap, replays inside the signature window, and an
 * audit log that is down when a change lands.
 */

const world = useDirectoryWorld();
const { deliver, lastEvent, memberRow, auditsFor, team, cron } = world;
const rowStatus = async (org: string, account: string) =>
  (
    await world.worker.db
      .prepare("SELECT status FROM org_members WHERE org_id = ? AND account_id = ?")
      .bind(org, account)
      .first<{ status: string }>()
  )?.status;

it("a user deleted on the same Events API page that made their membership keeps none", async () => {
  const ownerToken = await world.signIn(world.owner);
  const org = await world.api.createOrg(ownerToken, "Same page");
  const ada = workosUser("user_ada", "Ada");
  world.workos.orgs.knowUser(ada);
  world.workos.orgs.addMember(ada.id, org, "member");
  world.workos.orgs.deleteUser(ada.id);

  await cron();
  expect(await rowStatus(org, ada.id)).toBe("removed");
  expect(await memberRow(ownerToken, org, ada.id)).toBeUndefined();
  // The membership's own event coming again, late, doesn't bring her back.
  const created = world.workos.orgs
    .events()
    .find(
      (each) => each.event === "organization_membership.created" && each.data.user_id === ada.id,
    );
  if (!created) throw new Error("No membership event");
  expect(await deliver(created)).toBe(200);
  expect(await rowStatus(org, ada.id)).toBe("removed");
});

it("a membership's deletion that arrives before its creation keeps it deleted", async () => {
  const ownerToken = await world.signIn(world.owner);
  const org = await world.api.createOrg(ownerToken, "Backwards");
  const ben = workosUser("user_ben", "Ben");
  const membership = world.workos.orgs.addMember(ben.id, org, "member");
  const created = lastEvent();
  const deleted: Delivery = {
    id: "event_01BENGONE",
    event: "organization_membership.deleted",
    data: { ...membership, updated_at: new Date(Date.now() + 1_000).toISOString() },
    created_at: new Date(Date.now() + 1_000).toISOString(),
  };
  expect(await deliver(deleted)).toBe(200);
  expect(await deliver(created)).toBe(200);
  expect(await rowStatus(org, ben.id)).toBe("removed");
  expect(await memberRow(ownerToken, org, ben.id)).toBeUndefined();
});

it("a removal and an update at the same WorkOS time end removed, whichever comes first", async () => {
  const cal = workosUser("user_cal", "Cal");
  const { ownerToken, org } = await team("Tie", cal);
  const membership = world.workos.orgs.membership(cal.id, org);
  const at = new Date(Date.now() + 1_000).toISOString();
  const updated: Delivery = {
    id: "event_01CALUP",
    event: "organization_membership.updated",
    data: { ...membership, role: { slug: "admin" }, updated_at: at },
    created_at: at,
  };
  const deleted: Delivery = {
    id: "event_01CALDEL",
    event: "organization_membership.deleted",
    data: { ...membership, updated_at: at },
    created_at: at,
  };
  expect(await deliver(deleted)).toBe(200);
  expect(await deliver(updated)).toBe(200);
  expect(await rowStatus(org, cal.id)).toBe("removed");
  expect(await memberRow(ownerToken, org, cal.id)).toBeUndefined();
});

it("replaying a deactivation after a newer reactivation touches neither her org check nor her portal", async () => {
  const dee = workosUser("user_dee", "Dee");
  const { org, box, token } = await team("Replayed", dee);
  world.workos.orgs.deactivate(dee.id, org);
  const deactivated = lastEvent();
  world.workos.orgs.reactivate(dee.id, org);
  const reactivated = lastEvent();
  expect(await deliver(deactivated)).toBe(200);
  expect(await deliver(reactivated)).toBe(200);
  // Back in: a fresh org check, and the revocation her deactivation queued sent.
  expect((await world.api.memberGrant(token, org, box.hostId)).status).toBe(200);
  await cron();
  const revocations = () =>
    world.workos.orgs.portalRevocations().filter((each) => each.external_user_id === dee.id).length;
  const sent = revocations();

  const checks = async () =>
    JSON.stringify(
      (
        await world.worker.db
          .prepare(
            "SELECT checked_at, member_seq FROM org_checks WHERE org_id = ? AND account_id = ?",
          )
          .bind(org, dee.id)
          .all()
      ).results,
    );
  const checked = await checks();
  // Inside the signature window, the same signed deactivation, and the reactivation, again.
  expect(await deliver(deactivated)).toBe(200);
  expect(await deliver(reactivated)).toBe(200);
  await cron();
  expect(revocations()).toBe(sent);
  // Her org check stands, under the row it was decided on.
  expect(await checks()).toBe(checked);
});

it("an entry the audit log couldn't take is sent later, once, and none is sent for a change that didn't land", async () => {
  const eve = workosUser("user_eve", "Eve");
  const { org } = await team("Outbox", eve);
  // WorkOS Audit Logs is down while the directory deactivates her.
  world.workos.failNext((request) => request.path === "/audit_logs/events", 503, 2);
  world.workos.orgs.deactivate(eve.id, org);
  expect(await deliver(lastEvent())).toBe(200);
  expect(await rowStatus(org, eve.id)).toBe("inactive");
  expect(auditsFor(org, "org.member.deprovisioned")).toEqual([]);
  // The next runs send what waits; a replay of the same event adds nothing.
  for (let run = 0; run < 3; run++) await cron();
  expect(await deliver(lastEvent())).toBe(200);
  await cron();
  expect(auditsFor(org, "org.member.deprovisioned")).toHaveLength(1);

  // Two deliveries at once: a deactivation still deciding while a newer reactivation lands.
  // Fay never signed in, so WorkOS is asked for her name each time: that is where it waits.
  const fay = "user_fay";
  world.workos.orgs.addMember(fay, org, "member", { directory_managed: true });
  expect(await deliver(lastEvent())).toBe(200);
  world.workos.orgs.deactivate(fay, org);
  const out = lastEvent();
  world.workos.orgs.reactivate(fay, org);
  const back = lastEvent();
  const held = world.workos.holdNext(
    (request) => request.method === "GET" && request.path === `/user_management/users/${fay}`,
    "before",
  );
  const slow = deliver(out);
  await held.started;
  expect(await deliver(back)).toBe(200);
  held.release();
  expect(await slow).toBe(200);
  await cron();
  expect(await rowStatus(org, fay)).toBe("active");
  // The deactivation never landed over the newer reactivation, so it was never logged.
  expect(
    auditsFor(org, "org.member.deprovisioned").filter((each) =>
      JSON.stringify(each.targets).includes(fay),
    ),
  ).toEqual([]);
});

it("an organization's update at the same WorkOS time as its deletion leaves it deleted", async () => {
  const ownerToken = await world.signIn(world.owner);
  const org = await world.api.createOrg(ownerToken, "Tied away");
  const at = new Date(Date.now() + 1_000).toISOString();
  const data = { object: "organization", id: org, name: "Tied away", updated_at: at };
  const spaces = async () =>
    ((await world.api.call(ownerToken, "GET", "/v1/orgs")).body.orgs as { id: string }[]).map(
      (each) => each.id,
    );
  expect(await spaces()).toContain(org);
  expect(
    await deliver({ id: "event_01ORGDEL", event: "organization.deleted", data, created_at: at }),
  ).toBe(200);
  expect(
    await deliver({ id: "event_01ORGUP", event: "organization.updated", data, created_at: at }),
  ).toBe(200);
  expect(await spaces()).not.toContain(org);
});
