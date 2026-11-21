import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { signInThroughWorker, workosUser } from "@ace/cloud/testing";
import { canRunSpade, startThrowawaySpade } from "./cli/bot-kit-test-support.ts";
import { deviceKey, useAccountBackend } from "./machine-standing-test-support.ts";
import {
  helloWith,
  mia,
  orgTeamHost,
  provesMember,
  spadeHttp,
  type TeamHostOptions,
} from "./org-host-test-support.ts";
import type { SpadeLink } from "./spade/link.ts";
import { memberRequestStamp } from "./spade/member-stamp.ts";

// ADR 0206 between ace's daemon and a real Spade: a machine given to an organization through
// ace's account backend (the Worker and D1 under Miniflare, a fake WorkOS), its Spade bound to
// that organization by the daemon, members' writes to shared bots stamped and held by Spade to
// each member's right, the organization's signed policy fetched and applied, the host's audit
// log forwarded to the organization's WorkOS copy, and Spade let go on release.

const backend = useAccountBackend();
const lee = workosUser("user_lee", "Lee");

/** A real Spade on a throwaway folder, reading the same person key the daemon stamps with. */
async function realSpade() {
  const root = await mkdtemp(join(tmpdir(), "ace-org-spade-"));
  const aceHome = join(root, "ace");
  await mkdir(aceHome);
  const key = randomBytes(32);
  await writeFile(join(aceHome, "spade-person.key"), key.toString("hex"));
  const spade = await startThrowawaySpade(root, { SPADE_ACE_HOME: aceHome });
  const [host = "", port = ""] = spade.connection.address.split(":");
  const link = {
    ready: () => ({
      connection: { host, port: Number(port), token: spade.connection.token },
      generation: 1,
    }),
    status: () => ({ state: "ready", version: "test" }),
    subscribe: () => () => {},
    onRunEnded: () => () => {},
    personKey: () => new Uint8Array(key),
    listener: () => undefined,
  };
  return {
    api: spade.api,
    base: `http://${spade.connection.address}`,
    token: spade.connection.token,
    key,
    // What a socket and the server read of the link; Spade itself is real.
    link: link as unknown as SpadeLink,
    async stop() {
      spade.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Waits for `check` to hold, reading it again every 50 ms for up to `ms`. */
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`Never held: ${JSON.stringify(value)}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** An org host with a real Spade, bound to its organization, and a member's proven socket. */
async function teamWithSpade(server: TeamHostOptions["server"] = {}) {
  const spade = await realSpade();
  const team = await orgTeamHost(backend, { spade: spade.link, server });
  // The daemon gave Spade to the organization as it took in its enrollment.
  const bound = await until(
    () => spade.api("GET", "/v1/org"),
    (view) => (view.body as { org?: unknown }).org === team.org,
  );
  /** A proven member socket for the account `token` signs in as. */
  const member = async (token: string) => {
    const key = await deviceKey();
    const grant = await team.memberGrant(token, key.raw);
    const admitted = await helloWith(team.home, grant.token);
    const proven = await provesMember(
      admitted.client,
      team.home.host,
      admitted.nonce,
      grant.token,
      key,
    );
    expect(proven.ok).toBe(true);
    return admitted.client;
  };
  return { ...team, spade, bound: bound.body, member };
}

/** A shared bot `client`'s member makes: its id and conversation. */
async function sharedBot(
  spade: Awaited<ReturnType<typeof realSpade>>,
  client: Parameters<typeof spadeHttp>[0],
) {
  const made = await spadeHttp(client, "POST", "/v1/org/bots", {
    name: "CI watcher",
    task: "Watch CI.",
    model: "unreached/m",
  });
  expect(made).toMatchObject({ status: 201 });
  const id = String((made as { body: { agent: { id: string } } }).body.agent.id);
  const agents = (await spade.api("GET", "/v1/agents")).body as {
    agents: { id: string; conversation: string }[];
  };
  const conversation = agents.agents.find((agent) => agent.id === id)?.conversation ?? "";
  return { id, conversation };
}

it.skipIf(!canRunSpade)(
  "a member's writes to a shared bot carry their stamp, and Spade holds each to their right on it",
  async () => {
    const team = await teamWithSpade();
    expect(team.bound).toMatchObject({ org: team.org, name: "Team", host: team.home.host });
    const miaSocket = await team.member(team.miaToken);
    const { id, conversation } = await sharedBot(team.spade, miaSocket);
    // Mia made it: she narrows who may talk to it to herself.
    expect(
      await spadeHttp(miaSocket, "PUT", `/v1/agents/${id}/access`, {
        talk: [mia.id],
        approvers: [mia.id],
      }),
    ).toMatchObject({ status: 200 });
    const messages = `/v1/conversations/${conversation}/messages`;
    expect(await spadeHttp(miaSocket, "POST", messages, { text: "Is main green?" })).toMatchObject({
      status: 202,
    });

    // Lee is a member too, but not one who may talk to it now.
    backend.workos.orgs.addMember(lee.id, team.org, "member");
    await backend.worker.events();
    const leeToken = (await signInThroughWorker(backend.worker.http, backend.workos, lee)).token;
    const leeSocket = await team.member(leeToken);
    expect(await spadeHttp(leeSocket, "POST", messages, { text: "Me too" })).toMatchObject({
      status: 403,
    });
    // A socket that never proved a member's standing sends it unstamped: refused the same way.
    const unproven = await helloWith(
      team.home,
      (await team.memberGrant(team.miaToken, (await deviceKey()).raw)).token,
    );
    expect(await spadeHttp(unproven.client, "POST", messages, { text: "Hi" })).toMatchObject({
      status: 403,
    });

    // Mia's stamp, as the daemon makes it, is good only for the route and body it was made for.
    const body = JSON.stringify({ text: "Still green?" });
    const stamp = memberRequestStamp(
      team.spade.key,
      { method: "POST", path: messages, body: Buffer.from(body) },
      { account: mia.id, role: "member" },
      Date.now(),
      randomBytes(16).toString("hex"),
    );
    if (!stamp) throw new Error("No stamp");
    const send = (method: string, path: string, text: string) =>
      fetch(`${team.spade.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${team.spade.token}`,
          "content-type": "application/json",
          ...stamp,
        },
        body: text,
      }).then((response) => response.status);
    // Moved to another of the bot's routes, or onto another body: refused.
    expect(
      await send("PUT", `/v1/agents/${id}/access`, JSON.stringify({ approvers: [mia.id] })),
    ).toBe(403);
    expect(await send("POST", messages, JSON.stringify({ text: "Delete the repo" }))).toBe(403);
    // Where it was made for, it counts, once.
    expect(await send("POST", messages, body)).toBe(202);
    expect(await send("POST", messages, body)).toBe(403);
    await team.home.close();
    await team.spade.stop();
  },
  60_000,
);

it.skipIf(!canRunSpade)(
  "Full access on a shared bot is an admin's once the policy allows it, never a member's",
  async () => {
    const team = await teamWithSpade();
    const miaSocket = await team.member(team.miaToken);
    const { id } = await sharedBot(team.spade, miaSocket);
    const autonomy = `/v1/agents/${id}/security/autonomy`;
    const full = { autonomy: "full_access" };
    // Pat made the organization, so Pat is one of its owners.
    const patSocket = await team.member(team.home.session.token);
    // No policy of the organization's own yet: nobody raises a shared bot.
    expect(await spadeHttp(patSocket, "PUT", autonomy, full)).toMatchObject({ status: 403 });

    const set = await team.api.call(team.home.session.token, "PUT", `/v1/orgs/${team.org}/policy`, {
      policy: { full_access: "admins" },
    });
    expect(set.status).toBe(200);
    // Pat's next grant names version 1: the host fetches it and Spade applies it.
    const patAgain = await team.member(team.home.session.token);
    await until(
      () => team.spade.api("GET", "/v1/org"),
      (view) => (view.body as { policy?: number }).policy === 1,
    );
    // Mia configures the bot she made, but she isn't an admin.
    expect(await spadeHttp(miaSocket, "PUT", autonomy, full)).toMatchObject({ status: 403 });
    expect(await spadeHttp(patAgain, "PUT", autonomy, full)).toMatchObject({
      status: 200,
      body: { autonomy: "full_access" },
    });
    await team.home.close();
    await team.spade.stop();
  },
  60_000,
);

it.skipIf(!canRunSpade)(
  "the host's audit log reaches the organization in order, its policy comes on schedule, and release lets Spade go",
  async () => {
    const team = await teamWithSpade({ orgHostIntervals: { auditMs: 100, policyMs: 100 } });
    const miaSocket = await team.member(team.miaToken);
    const { id } = await sharedBot(team.spade, miaSocket);
    expect(
      await spadeHttp(miaSocket, "PUT", `/v1/agents/${id}/access`, {
        talk: [mia.id],
        approvers: [mia.id],
      }),
    ).toMatchObject({ status: 200 });
    // Both entries reach WorkOS, oldest first, and Spade's outbox empties.
    const forwarded = await until(
      async () =>
        backend.workos.orgs
          .audits()
          .filter((audit) => audit.org === team.org)
          .map((audit) => String((audit.event as { action?: unknown }).action))
          .filter((action) => action.startsWith("bot.")),
      (actions) => actions.length >= 2,
    );
    expect(forwarded).toEqual(["bot.created", "bot.access_changed"]);
    await until(
      () => team.spade.api("GET", "/v1/org/audit/outbox"),
      (outbox) => (outbox.body as { entries: unknown[] }).entries.length === 0,
    );

    // A policy set while nobody proves anything still reaches Spade on its schedule.
    const set = await team.api.call(team.home.session.token, "PUT", `/v1/orgs/${team.org}/policy`, {
      policy: { effects: { pay: "off" } },
    });
    expect(set.status).toBe(200);
    await until(
      () => team.spade.api("GET", "/v1/org"),
      (view) => (view.body as { policy?: number }).policy === 1,
    );

    // An owner releases the host: Spade belongs to no organization any more, and its shared bot
    // is still there.
    const patSocket = await team.member(team.home.session.token);
    // Releasing ends every standing proven on the host, this socket's too, so it closes.
    patSocket.send({ type: "account.owner.release", requestId: "release" });
    await until(
      async () => team.home.account.status().owner,
      (owner) => owner === null,
    );
    await until(
      () => team.spade.api("GET", "/v1/org"),
      (view) => (view.body as { org?: unknown }).org === null,
    );
    const agents = (await team.spade.api("GET", "/v1/agents")).body as { agents: { id: string }[] };
    expect(agents.agents.map((agent) => agent.id)).toContain(id);
    await team.home.close();
    await team.spade.stop();
  },
  60_000,
);
