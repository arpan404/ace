import { createHmac } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { fakeWorkos } from "./fake-workos.ts";
import { startWorker } from "./harness.ts";
import { orgCalls, workosUser } from "./org-calls.ts";
import { signInThroughWorker } from "./sign-in.ts";

/** The secret the directory tests' Worker checks webhook deliveries with. */
export const WEBHOOK_SECRET = "whsec_test_directory_sync_secret";
/** One WorkOS event, as the Events API and the webhook carry it. */
export type Delivery = { id: string; event: string; data: unknown; created_at: string };

/**
 * The real Worker and D1 with a fake WorkOS and the webhook's secret set, for one test file
 * (ADR 0206 §6), and what its tests do to it: sign people in, deliver signed events, read the
 * members list and the organization's WorkOS audit copy.
 */
export function useDirectoryWorld(world: { vars?: Record<string, string> } = {}) {
  let workos: Awaited<ReturnType<typeof fakeWorkos>> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const sessions = new Map<string, Promise<string>>();
  beforeAll(async () => {
    workos = await fakeWorkos();
    worker = await startWorker({
      workosUrl: workos.url,
      vars: { WORKOS_WEBHOOK_SECRET: WEBHOOK_SECRET, ...world.vars },
    });
  });
  afterAll(async () => {
    await worker?.close();
    await workos?.close();
  });
  const ready = () => {
    if (!workos || !worker) throw new Error("The directory world hasn't started");
    return { workos, worker, api: orgCalls(worker.http) };
  };
  const owner = workosUser("user_dirowner", "Dora");
  function signIn(user: ReturnType<typeof workosUser>, holder: "person" | "machine" = "person") {
    const key = `${user.id}:${holder}`;
    let session = sessions.get(key);
    if (!session) {
      const { worker: w, workos: fake } = ready();
      session = signInThroughWorker(w.http, fake, user, holder).then((grant) => grant.token);
      sessions.set(key, session);
    }
    return session;
  }
  /** Posts `event` to the webhook as WorkOS would: signed at `at` with `secret`. */
  async function deliver(
    event: Delivery,
    options: { secret?: string; at?: number; header?: string | null; body?: string } = {},
  ) {
    const body = options.body ?? JSON.stringify(event);
    const at = options.at ?? Date.now();
    const mac = createHmac("sha256", options.secret ?? WEBHOOK_SECRET)
      .update(`${at}.${JSON.stringify(event)}`)
      .digest("hex");
    const header = options.header === undefined ? `t=${at}, v1=${mac}` : options.header;
    const response = await fetch(`${ready().worker.http}/v1/workos/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(header ? { "WorkOS-Signature": header } : {}),
      },
      body,
    });
    return response.status;
  }
  const lastEvent = (): Delivery => {
    const event = ready().workos.orgs.events().at(-1);
    if (!event) throw new Error("WorkOS made no event");
    return event;
  };
  const memberRow = async (ownerToken: string, org: string, account: string) => {
    const listed = await ready().api.call(ownerToken, "GET", `/v1/orgs/${org}/members`);
    return (listed.body.members as { account: string }[]).find((each) => each.account === account);
  };
  const auditsFor = (org: string, action: string) =>
    ready()
      .workos.orgs.audits()
      .filter((each) => each.org === org && each.event.action === action)
      .map((each) => each.event);
  /** An org owned by Dora with a host, and `person` a directory-managed member of it. */
  async function team(name: string, person: ReturnType<typeof workosUser>) {
    const { api, workos: fake, worker: w } = ready();
    const ownerToken = await signIn(owner);
    const org = await api.createOrg(ownerToken, name);
    fake.orgs.addMember(person.id, org, "member", { directory_managed: true });
    await w.cron("* * * * *");
    const box = await api.machine(w.db, owner.id, await signIn(owner, "machine"));
    const enrolled = await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id));
    if (enrolled.status !== 201) throw new Error(`Enrolling failed: ${enrolled.status}`);
    return { ownerToken, org, box, token: await signIn(person) };
  }
  return {
    get workos() {
      return ready().workos;
    },
    get worker() {
      return ready().worker;
    },
    get api() {
      return ready().api;
    },
    owner,
    signIn,
    deliver,
    lastEvent,
    memberRow,
    auditsFor,
    team,
    /** The minute's cron: the Events API run, then retries of what waits. */
    cron: () => ready().worker.cron("* * * * *"),
  };
}
