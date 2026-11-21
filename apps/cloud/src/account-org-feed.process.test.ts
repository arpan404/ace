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

it("a membership's deletion keeps its later events out even when it arrives older than the row", async () => {
  const gil = workosUser("user_gil", "Gil");
  const { ownerToken, org } = await team("Deleted late", gil);
  const membership = world.workos.orgs.membership(gil.id, org);
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const event = (
    id: string,
    name: string,
    created: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    event: name,
    data: { ...membership, ...extra, updated_at: created },
    created_at: created,
  });
  const [early, middle, late] = [at(1_000), at(2_000), at(3_000)];
  // The row is already at `middle` when the deletion, from `early`, arrives.
  expect(await deliver(event("event_01GILUP", "organization_membership.updated", middle))).toBe(
    200,
  );
  expect(await deliver(event("event_01GILDEL", "organization_membership.deleted", early))).toBe(
    200,
  );
  // That membership is deleted: no event of it lands afterwards.
  expect(
    await deliver(
      event("event_01GILLATE", "organization_membership.updated", late, {
        role: { slug: "admin" },
      }),
    ),
  ).toBe(200);
  expect(await memberRow(ownerToken, org, gil.id)).toMatchObject({ role: "member" });
});

it("deleting another membership at the same WorkOS time as the row changes nothing and logs nothing", async () => {
  const hal = workosUser("user_hal", "Hal");
  const { ownerToken, org, box, token } = await team("Other id", hal);
  const created = world.workos.orgs
    .events()
    .find(
      (each) => each.event === "organization_membership.created" && each.data.user_id === hal.id,
    );
  if (!created) throw new Error("No membership event");
  expect(
    await deliver({
      id: "event_01HALOTHER",
      event: "organization_membership.deleted",
      data: { ...created.data, id: "om_01SOMEOTHER" },
      created_at: created.created_at,
    }),
  ).toBe(200);
  await cron();
  expect(await memberRow(ownerToken, org, hal.id)).toMatchObject({ status: "active" });
  expect(auditsFor(org, "org.member.removed")).toEqual([]);
  expect((await world.api.memberGrant(token, org, box.hostId)).status).toBe(200);
});

it("a user with more than a thousand memberships on record is deleted from every one", async () => {
  const ivy = workosUser("user_ivy", "Ivy");
  const { ownerToken, org } = await team("Many", ivy);
  // Years of history: 1,200 older memberships of hers, in other organizations.
  await world.worker.db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
       INSERT INTO org_members (org_id, account_id, membership_id, role, status, directory_managed, version, joined_at, profile_version)
       SELECT 'org_01OLD' || i, ?1, 'om_01OLD' || i, 'member', 'inactive', 0, '2026-01-01T00:00:00.000Z', 0, '' FROM n`,
    )
    .bind(ivy.id)
    .run();
  world.workos.orgs.deleteUser(ivy.id);
  expect(await deliver(lastEvent())).toBe(200);
  const left = await world.worker.db
    .prepare("SELECT COUNT(*) AS n FROM org_members WHERE account_id = ? AND status != 'removed'")
    .bind(ivy.id)
    .first<{ n: number }>();
  expect(left?.n).toBe(0);
  expect(await memberRow(ownerToken, org, ivy.id)).toBeUndefined();
  // Her directory-managed membership's removal is on the organization's record, once.
  await cron();
  expect(auditsFor(org, "org.member.removed")).toEqual([
    expect.objectContaining({ actor: { type: "idp", id: "directory" } }),
  ]);
});
