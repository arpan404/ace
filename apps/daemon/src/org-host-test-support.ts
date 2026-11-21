import { expect } from "vitest";
import { orgCalls, signInThroughWorker, workosUser } from "@ace/cloud/testing";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import type { SpadeLink } from "./spade/link.ts";
import {
  answer,
  pageProves,
  person,
  signedInDaemon,
  type useAccountBackend,
} from "./machine-standing-test-support.ts";

/*
 * An organization's host for the ADR 0206 daemon suites: a real daemon on ace's account backend
 * (the Worker and D1 under Miniflare, a fake WorkOS), given to an organization by its owner.
 */

type AccountBackend = ReturnType<typeof useAccountBackend>;
/** The organization's member in these suites. */
export const mia = workosUser("user_mia", "Mia");

/**
 * A machine Pat owns and signed in, an organization Pat created with Mia as a member, the
 * backend told the machine is the org's host with the machine's own consent; `confirm: false`
 * stops before the daemon takes that in, so the machine stays Pat's.
 */
export async function orgTeamHost(
  backend: AccountBackend,
  options: { confirm?: boolean; spade?: SpadeLink } = {},
) {
  const home = await signedInDaemon(options.spade ? { spade: options.spade } : {});
  const api = orgCalls(backend.worker.http);
  const owner = await pageProves(home, home.session.token);
  expect(owner.ok).toBe(true);
  const org = await api.createOrg(home.session.token, "Team");
  backend.workos.orgs.addMember(mia.id, org, "member");
  await backend.worker.events();
  await backend.worker.seeMachine(home.host, person.id);
  owner.client.send({ type: "account.owner.enroll", requestId: "enroll", org });
  const given = (await answer(owner.client, "account.owner.enroll.result")).result;
  if (!given.ok) throw new Error(`No consent: ${given.code}`);
  expect(
    (await api.enroll(home.session.token, org, { hostId: home.host }, given.consent)).status,
  ).toBe(201);
  if (options.confirm !== false) {
    owner.client.send({ type: "account.owner.enroll.confirm", requestId: "confirm", org });
    expect((await answer(owner.client, "account.owner.enroll.confirm.result")).ok).toBe(true);
    expect(home.account.status().owner).toEqual({ org });
  }
  const miaToken = (await signInThroughWorker(backend.worker.http, backend.workos, mia)).token;
  /** A member grant the backend mints for `token` on this host, for the device key `key`. */
  const memberGrant = async (token: string, key: string) => {
    const minted = await api.call(token, "POST", "/v1/grants", {
      kind: "member",
      org,
      host: home.host,
      subject: "phone",
      key,
    });
    return { status: minted.status, token: String(minted.body.token) };
  };
  return { home, org, owner, miaToken, memberGrant, api };
}

/** A device's socket that says hello with `grant`: its welcome's nonce, or its refusal. */
export async function helloWith(home: Awaited<ReturnType<typeof signedInDaemon>>, grant: string) {
  const client = await home.f.open();
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("phone"), grant });
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === "welcome") return { client, nonce: message.standingNonce ?? "" };
    if (message.type === "error") return { client, nonce: "", refused: message.code };
  }
}
