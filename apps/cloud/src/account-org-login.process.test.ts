import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * `ace login --org` at the backend (ADR 0206 §1.4): a daemon's sign-in started for an
 * organization says it entered it only for an active member, on WorkOS's word.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

it("a machine's sign-in for an organization names it for a member and never for anyone else", async () => {
  const api = orgCalls(worker.http);
  const tess = workosUser("user_tess", "Tess");
  const org = await api.createOrg(
    await signInThroughWorker(worker.http, workos, tess).then((g) => g.token),
    "Login",
  );
  const uma = workosUser("user_uma", "Uma");
  workos.orgs.addMember(uma.id, org, "member");

  const member = await signInThroughWorker(worker.http, workos, uma, "machine", { org });
  expect(member.org).toBe(org);
  // Not a member: the sign-in itself finishes, but it entered no organization.
  const stranger = await signInThroughWorker(
    worker.http,
    workos,
    workosUser("user_vic", "Vic"),
    "machine",
    { org },
  );
  expect(stranger.org).toBeUndefined();
  // Deactivated: WorkOS no longer puts the session in it.
  workos.orgs.deactivate(uma.id, org);
  const former = await signInThroughWorker(worker.http, workos, uma, "machine", { org });
  expect(former.org).toBeUndefined();
  // A sign-in that asked for no organization never names one.
  workos.orgs.addMember("user_wes", org, "member");
  expect(
    (await signInThroughWorker(worker.http, workos, workosUser("user_wes", "Wes"), "machine")).org,
  ).toBeUndefined();
});
