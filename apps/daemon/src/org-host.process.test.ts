import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, it } from "vitest";
import { GRANT_LIFETIME_MS, standingProofText } from "@ace/account-grant";
import { orgCalls, signInThroughWorker, workosUser } from "@ace/cloud/testing";
import { DeviceId, ThreadId, type ServerMessage } from "@ace/protocol";
import type { SpadeAccess } from "./services/spade-session.ts";
import type { SpadeLink } from "./spade/link.ts";
import type { Client } from "./socket-test-support.ts";
import {
  answer,
  deviceKey,
  pageProves,
  person,
  signedInDaemon,
  useAccountBackend,
} from "./machine-standing-test-support.ts";

// ADR 0206 §2.1–§2.3 end to end: a real daemon signed in through ace's account backend (the
// Worker and D1 under Miniflare, against a fake WorkOS), given to an organization by its owner,
// and the organization's members on it: who is admitted, whose standing counts and for how
// long, and what reaches Spade when a member answers a raised request.

const backend = useAccountBackend();
const mia = workosUser("user_mia", "Mia");
const approval = "/v1/conversations/c_1/approvals/call_1";

/** A Spade that records what reaches it, for a daemon to forward to. */
async function recordingSpade(): Promise<{
  spade: SpadeLink;
  seen: { path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}> {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers });
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const spade: SpadeAccess & Pick<SpadeLink, "listener"> = {
    ready: () => ({
      connection: { host: "127.0.0.1", port: address.port, token: "t".repeat(64) },
      generation: 1,
    }),
    status: () => ({ state: "ready" }),
    subscribe: () => () => {},
    onRunEnded: () => () => {},
    personKey: () => new Uint8Array(32).fill(7),
    listener: () => undefined,
  };
  return {
    seen,
    // What a socket and the server read of the link; nothing else of it runs here.
    spade: spade as unknown as SpadeLink,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * A machine Pat owns and signed in, an organization Pat created with Mia as a member, the
 * backend told the machine is the org's host with the machine's own consent; `confirm: false`
 * stops before the daemon takes that in, so the machine stays Pat's.
 */
async function teamHost(options: { confirm?: boolean; spade?: SpadeLink } = {}) {
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

/**
 * Tries to turn "Ask me before agents publish" off: true when the daemon let this socket. A
 * socket refused the whole service is told so with an error instead of a result.
 */
async function changesSetting(client: Client): Promise<boolean> {
  client.send({
    type: "settings.set",
    requestId: "ask",
    key: "market.askBeforeAgentPublish",
    value: false,
    layer: { kind: "global" },
  });
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === "settings.result") return message.ok;
    if (message.type === "error" && message.requestId === "ask") return false;
  }
}

/** A device's socket that says hello with `grant`: its welcome's nonce, or its refusal. */
async function helloWith(home: Awaited<ReturnType<typeof signedInDaemon>>, grant: string) {
  const client = await home.f.open();
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("phone"), grant });
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === "welcome") return { client, nonce: message.standingNonce ?? "" };
    if (message.type === "error") return { client, nonce: "", refused: message.code };
  }
}

/** Proves `grant` on `client` with `key`'s signature over its nonce. */
async function provesMember(
  client: Client,
  host: string,
  nonce: string,
  grant: string,
  key: Awaited<ReturnType<typeof deviceKey>>,
) {
  const proof = await key.sign(standingProofText({ host, nonce, binding: undefined, grant }));
  client.send({ type: "account.standing", requestId: "member", grant, proof });
  return (await answer(client, "account.standing.result")).result;
}

/** Answers the raised request at `approval` over `client`: what came back. */
async function answers(client: Client, requestId: string) {
  client.send({
    type: "spade.http",
    requestId,
    method: "POST",
    path: approval,
    body: JSON.stringify({ allowed: true }),
    encoding: "text",
  });
  for (;;) {
    const message = await answer(client, "spade.http.result");
    if (message.requestId === requestId) return message.result;
  }
}

it("a personal machine refuses every member grant, even for a host the backend lists as the org's", async () => {
  // The backend enrolled the host, but the machine never took it in: it is still Pat's.
  const { home, owner, miaToken, memberGrant } = await teamHost({ confirm: false });
  expect(home.account.status().owner).toEqual({ account: person.id });
  const key = await deviceKey();
  const grant = await memberGrant(miaToken, key.raw);
  expect(grant.status).toBe(200);
  // Not as a hello's grant, and not as standing on a socket that is already open.
  expect((await helloWith(home, grant.token)).refused).toBe("unauthorized");
  const page = await home.pageSocket();
  expect((await provesMember(page.client, home.host, page.nonce, grant.token, key)).ok).toBe(false);
  expect(await changesSetting(page.client)).toBe(false);
  // Pat is still the person here.
  expect(await changesSetting(owner.client)).toBe(true);
  await home.close();
});

it("an org host admits its own members and refuses another organization's grant and its old owner's", async () => {
  const { home, org, owner, miaToken, memberGrant } = await teamHost();
  const key = await deviceKey();
  const grant = await memberGrant(miaToken, key.raw);
  const admitted = await helloWith(home, grant.token);
  expect(admitted.refused).toBeUndefined();
  expect(await provesMember(admitted.client, home.host, admitted.nonce, grant.token, key)).toEqual({
    ok: true,
    until: expect.any(Number),
    member: { org, role: "member" },
  });
  // A member reaches Spade only: nothing person-only, and not the host's shell, even with their
  // standing proven.
  expect(await changesSetting(admitted.client)).toBe(false);
  admitted.client.send({
    type: "terminal.request",
    requestId: "shell",
    operation: { op: "list", threadId: ThreadId.parse("t_none") },
  });
  expect(await answer(admitted.client, "error")).toMatchObject({
    code: "forbidden",
    requestId: "shell",
  });

  // Another organization's member grant for this very host and device key.
  const foreign = backend.worker.mintMember({
    org: "org_elsewhere",
    role: "owner",
    account: mia.id,
    subject: "phone",
    host: home.host,
    key: key.raw,
    policy: 0,
  });
  expect((await helloWith(home, foreign)).refused).toBe("unauthorized");
  expect((await provesMember(admitted.client, home.host, admitted.nonce, foreign, key)).ok).toBe(
    false,
  );

  // Pat no longer owns the machine: their standing ended with the enrollment, and their
  // person's grant proves nothing here now.
  expect(await changesSetting(owner.client)).toBe(false);
  expect((await pageProves(home, home.session.token)).ok).toBe(false);
  await home.close();
});

it("a member's standing ends at their grant's expiry, and with it an owner's use of the host's shell", async () => {
  // Pat made the organization, so Pat is one of its owners; their member grant admits them.
  const { home, org, memberGrant } = await teamHost();
  const key = await deviceKey();
  const admitted = await helloWith(home, (await memberGrant(home.session.token, key.raw)).token);
  expect(admitted.refused).toBeUndefined();
  const shell = async (requestId: string) => {
    admitted.client.send({
      type: "terminal.request",
      requestId,
      operation: { op: "list", threadId: ThreadId.parse("t_none") },
    });
    for (;;) {
      const message: ServerMessage = await admitted.client.next();
      if (message.type === "error" && message.requestId === requestId) return message.code;
      if (message.type === "terminal.result" && message.requestId === requestId) return "answered";
    }
  };
  // Admitted, not proven: the shell is an owner's, proven on this connection.
  expect(await shell("unproven")).toBe("forbidden");
  // Their last grant, with a second and a half left.
  const lastMs = 1_500;
  const short = backend.worker.mintMember(
    {
      org,
      role: "owner",
      account: person.id,
      subject: "phone",
      host: home.host,
      key: key.raw,
      policy: 0,
    },
    Date.now() - GRANT_LIFETIME_MS + lastMs,
  );
  const proven = await provesMember(admitted.client, home.host, admitted.nonce, short, key);
  expect(proven).toMatchObject({ ok: true, member: { org, role: "owner" } });
  if (proven.ok) expect(proven.until).toBeLessThanOrEqual(Date.now() + lastMs);
  expect(await shell("proven")).not.toBe("forbidden");
  await new Promise((resolve) => setTimeout(resolve, lastMs + 200));
  expect(await shell("expired")).toBe("forbidden");
  // And a grant that has run out proves nothing again.
  expect((await provesMember(admitted.client, home.host, admitted.nonce, short, key)).ok).toBe(
    false,
  );
  await home.close();
});

it("the member stamp reaches Spade on an approval, and an answer sent after deprovisioning is refused", async () => {
  const recorder = await recordingSpade();
  const { home, org, miaToken, memberGrant } = await teamHost({ spade: recorder.spade });
  const key = await deviceKey();
  const admitted = await helloWith(home, (await memberGrant(miaToken, key.raw)).token);
  // Before proving anything, an answer isn't forwarded: nobody stands behind it.
  expect(await answers(admitted.client, "unproven")).toMatchObject({
    kind: "error",
    code: "forbidden",
  });
  expect(recorder.seen).toEqual([]);

  // Her last grant, with a second and a half left.
  const lastMs = 1_500;
  const last = backend.worker.mintMember(
    {
      org,
      role: "member",
      account: mia.id,
      subject: "phone",
      host: home.host,
      key: key.raw,
      policy: 0,
    },
    Date.now() - GRANT_LIFETIME_MS + lastMs,
  );
  expect((await provesMember(admitted.client, home.host, admitted.nonce, last, key)).ok).toBe(true);
  expect(await answers(admitted.client, "proven")).toMatchObject({ kind: "response", status: 202 });
  expect(recorder.seen.map((request) => request.path)).toEqual([approval]);
  const stamp = recorder.seen[0]?.headers["x-ace-member"];
  // `v1.<ms>.<nonce>.<account>.<HMAC>`: the member who answered is under the HMAC.
  expect(stamp).toMatch(new RegExp(`^v1\\.\\d+\\.[0-9a-f]{32}\\.${mia.id}\\.[0-9a-f]{64}$`));
  expect(recorder.seen[0]?.headers["x-ace-person"]).toBeUndefined();

  // Deprovisioned: the backend mints her nothing more, and once her last grant runs out, her
  // answer is refused before it reaches Spade.
  backend.workos.orgs.deactivate(mia.id, org);
  await backend.worker.events();
  expect((await memberGrant(miaToken, key.raw)).status).not.toBe(200);
  await new Promise((resolve) => setTimeout(resolve, lastMs + 200));
  expect(await answers(admitted.client, "after")).toMatchObject({
    kind: "error",
    code: "forbidden",
  });
  expect(recorder.seen).toHaveLength(1);
  await home.close();
  await recorder.close();
});
