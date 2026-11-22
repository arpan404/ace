import { expect, it } from "vitest";
import { DeviceId, ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { redeemPairing } from "./client-access.ts";
import type { Client } from "./socket-test-support.ts";
import { token } from "./socket-test-support.ts";
import { answer, deviceKey, linkFrom, useAccountBackend } from "./machine-standing-test-support.ts";
import { helloWith, orgTeamHost, provesMember } from "./org-host-test-support.ts";

// ADR 0209 §3–§4 end to end: a real daemon given to an organization on ace's account backend
// (the Worker and D1 under Miniflare, a fake WorkOS), and every entry point of §4.1 this server
// carries, tried by every principal against a tree that is no member's: the daemon's own dev
// thread, which no access row places. Then the same table on a person's machine, unchanged.

const backend = useAccountBackend();
type Home = Awaited<ReturnType<typeof orgTeamHost>>["home"];
type Outcome = "allowed" | "refused";

let requests = 0;
/**
 * Sends `message` and reads the first answer naming it: a policy refusal is an `error` naming
 * the request (or subscription, or command) with code `forbidden`; any other answer is the
 * service's, so the policy let it through.
 */
async function outcome(client: Client, build: (id: string) => ClientMessage): Promise<Outcome> {
  const id = `r${++requests}`;
  const message = build(id);
  client.send(message);
  const commandId = message.type === "command" ? message.command.id : undefined;
  const deadline = Date.now() + 8_000;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`No answer to ${message.type}`);
    const next: ServerMessage | undefined = await Promise.race([
      client.next(),
      new Promise<undefined>((resolve) => setTimeout(resolve, left)),
    ]);
    if (!next) throw new Error(`No answer to ${message.type}`);
    const names =
      Reflect.get(next, "requestId") === id ||
      Reflect.get(next, "subscriptionId") === id ||
      (commandId !== undefined && Reflect.get(next, "commandId") === commandId);
    if (!names) continue;
    // A frame the protocol refuses never reached the policy: the table itself is wrong.
    if (next.type === "error" && (next.code === "invalid_message" || next.code === "unsupported"))
      throw new Error(`${message.type} doesn't match the protocol`);
    return next.type === "error" && next.code === "forbidden" ? "refused" : "allowed";
  }
}

/** Each JSON entry point, as one message against `thread`. */
const messages = (thread: ThreadId) =>
  ({
    "subscribe to a thread": (id: string) => ({
      type: "subscribe",
      subscriptionId: id,
      scope: { kind: "thread", threadId: thread },
    }),
    "page a thread's items": (id: string) => ({
      type: "items.page",
      requestId: id,
      threadId: thread,
      before: 1,
      limit: 10,
    }),
    "send into a thread": (id: string) => ({
      type: "command",
      command: {
        id: `cmd_${id}`,
        deviceId: DeviceId.parse("phone"),
        payload: { type: "thread.send", threadId: thread, input: [{ type: "text", text: "hi" }] },
      },
    }),
    "a terminal in a thread": (id: string) => ({
      type: "terminal.request",
      requestId: id,
      operation: { op: "list", threadId: thread },
    }),
    "read the daemon's settings": (id: string) => ({
      type: "settings.get",
      requestId: id,
      key: "market.askBeforeAgentPublish",
      scope: { kind: "global" },
    }),
    "ask Spade": (id: string) => ({
      type: "spade.http",
      requestId: id,
      method: "GET",
      path: "/v1/bots",
      encoding: "text",
    }),
    "make a pairing link": (id: string) => ({
      type: "fleet.request",
      requestId: id,
      operation: { op: "pairing", scopes: ["read"] },
    }),
    "list transfers": (id: string) => ({
      type: "transfers.request",
      requestId: id,
      operation: { op: "list" },
    }),
    "use the screen": (id: string) => ({
      type: "screen.request",
      requestId: id,
      operation: { op: "status" },
    }),
  }) as unknown as Record<string, (id: string) => ClientMessage>;

/** Whether a hello on `channel` is welcomed. */
async function opens(home: Home, hello: Record<string, unknown>): Promise<Outcome> {
  const client = await home.f.open();
  client.send({ type: "hello", protocolVersion: 1, ...hello } as ClientMessage);
  for (;;) {
    const next: ServerMessage = await client.next();
    if (next.type === "welcome") return "allowed";
    if (next.type === "error") return "refused";
  }
}

/** An HTTP request on the loopback listener: refused by the policy, or answered by its route. */
async function http(home: Home, method: string, path: string, bearer?: string): Promise<Outcome> {
  const response = await fetch(new URL(path, home.f.server.httpUrl), {
    method,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const body = await response.text();
  return response.status === 403 && body.includes("org_host_refused") ? "refused" : "allowed";
}

/** The socket of each principal on `home`, an org host. */
async function orgPrincipals(team: Awaited<ReturnType<typeof orgTeamHost>>) {
  const { home, miaToken, memberGrant } = team;
  const miaKey = await deviceKey();
  const admitted = await helloWith(home, (await memberGrant(miaToken, miaKey.raw)).token);
  const memberKey = await deviceKey();
  const proven = await helloWith(home, (await memberGrant(miaToken, memberKey.raw)).token);
  const grant = (await memberGrant(miaToken, memberKey.raw)).token;
  expect((await provesMember(proven.client, home.host, proven.nonce, grant, memberKey)).ok).toBe(
    true,
  );
  // Pat made the organization, so Pat is one of its owners.
  const ownerKey = await deviceKey();
  const owner = await helloWith(home, (await memberGrant(home.session.token, ownerKey.raw)).token);
  const ownerGrant = (await memberGrant(home.session.token, ownerKey.raw)).token;
  expect((await provesMember(owner.client, home.host, owner.nonce, ownerGrant, ownerKey)).ok).toBe(
    true,
  );
  const host = await home.pageSocket();
  return {
    "the host's token": host.client,
    "an admitted member, unproven": admitted.client,
    "a proven member": proven.client,
    "a proven org owner": owner.client,
  };
}

// Each principal's outcome per entry point on an org host, in the order the principals list.
const onOrgHost: Record<string, readonly Outcome[]> = {
  //                          host        admitted    member      org owner
  "subscribe to a thread": ["refused", "refused", "refused", "refused"],
  "page a thread's items": ["refused", "refused", "refused", "refused"],
  "send into a thread": ["refused", "refused", "refused", "refused"],
  "a terminal in a thread": ["allowed", "refused", "refused", "allowed"],
  "read the daemon's settings": ["allowed", "refused", "refused", "allowed"],
  "ask Spade": ["refused", "refused", "allowed", "allowed"],
  "make a pairing link": ["refused", "refused", "refused", "refused"],
  "list transfers": ["refused", "refused", "refused", "refused"],
  "use the screen": ["refused", "refused", "refused", "refused"],
};

it("an org host decides every entry point for every principal, deny by default", async () => {
  const team = await orgTeamHost(backend);
  const { home, memberGrant, miaToken } = team;
  const thread = home.f.thread.id;
  const principals = await orgPrincipals(team);
  const table = messages(thread);
  for (const [entry, expected] of Object.entries(onOrgHost)) {
    const build = table[entry];
    if (!build) throw new Error(`No entry ${entry}`);
    const seen: Outcome[] = [];
    for (const client of Object.values(principals)) seen.push(await outcome(client, build));
    expect({ entry, seen }).toEqual({ entry, seen: expected });
  }

  // Dedicated channels: the host's shell opens for the host's token; a tree's browser, the
  // screen and the machine tunnel for nobody; a member admission opens none, having proven
  // nothing yet.
  const local = { deviceId: DeviceId.parse("device"), token };
  expect(await opens(home, { ...local, channel: "files" })).toBe("allowed");
  for (const channel of ["browser", "screen", "tunnel", "machine"])
    expect({ channel, seen: await opens(home, { ...local, channel }) }).toEqual({
      channel,
      seen: "refused",
    });
  const key = await deviceKey();
  const grant = (await memberGrant(home.session.token, key.raw)).token;
  for (const channel of ["files", "devices", "browser"])
    expect({
      channel,
      seen: await opens(home, { deviceId: DeviceId.parse("phone"), grant, channel }),
    }).toEqual({ channel, seen: "refused" });

  // HTTP: the host's bearer is the operator, so no attachment, upload or preview; no pairing
  // is made or redeemed; it still runs the daemon.
  const sha = "0".repeat(64);
  expect(await http(home, "GET", `/v1/attachments/${thread}/${sha}/original`, token)).toBe(
    "refused",
  );
  expect(await http(home, "POST", `/v1/attachments/${thread}/upload`, token)).toBe("refused");
  expect(await http(home, "POST", "/v1/previews/3000/link", token)).toBe("refused");
  expect(await http(home, "POST", "/v1/pairings", token)).toBe("refused");
  expect(await http(home, "POST", "/v1/pair")).toBe("refused");
  expect(await http(home, "GET", "/v1/devices", token)).toBe("allowed");
  // A member grant isn't an HTTP credential, and nothing else names a member there.
  const memberBearer = (await memberGrant(miaToken, key.raw)).token;
  expect(await http(home, "GET", `/v1/attachments/${thread}/${sha}/original`, memberBearer)).toBe(
    "refused",
  );
  await home.close();
});

it("an org host revokes the devices paired before it, and refuses their sockets and calls", async () => {
  // Paired while the machine was still Pat's.
  const team = await orgTeamHost(backend, { confirm: false });
  const { home, owner, org } = team;
  const url = await linkFrom(owner.client);
  const paired = await redeemPairing(url, "Phone");
  const revokedAt = () =>
    home.f.store.devices.list().find((device) => device.id === paired.device.id)?.revokedAt;
  expect(revokedAt()).toBe(null);
  owner.client.send({ type: "account.owner.enroll.confirm", requestId: "confirm", org });
  expect((await answer(owner.client, "account.owner.enroll.confirm.result")).ok).toBe(true);
  expect(home.account.status().owner).toEqual({ org });
  // Revoked, not only stripped of standing: its bearer opens nothing, on any route.
  expect(revokedAt()).toEqual(expect.any(Number));
  await expect(home.f.ticket(paired.token)).rejects.toThrow();
  await expect(
    home.f.remoteRequest("/v1/machine-calls", { method: "POST", token: paired.token, body: {} }),
  ).rejects.toThrow(/org_host_refused/);
  await expect(
    home.f.remoteRequest("/v1/transfers", { method: "POST", token: paired.token, body: {} }),
  ).rejects.toThrow(/org_host_refused/);
  await home.close();
});

it("a person's machine answers every one of those entry points as it always has", async () => {
  // The backend lists the host as the org's, but the machine never took it in: still Pat's.
  const { home, owner } = await orgTeamHost(backend, { confirm: false });
  const thread = home.f.thread.id;
  const host = await home.pageSocket();
  const table = messages(thread);
  for (const entry of Object.keys(onOrgHost)) {
    const build = table[entry];
    if (!build) throw new Error(`No entry ${entry}`);
    for (const [who, client] of Object.entries({ host: host.client, owner: owner.client }))
      expect({ entry, who, seen: await outcome(client, build) }).toEqual({
        entry,
        who,
        seen: "allowed",
      });
  }
  const local = { deviceId: DeviceId.parse("device"), token };
  for (const channel of ["files", "browser", "tunnel"])
    expect({ channel, seen: await opens(home, { ...local, channel }) }).toEqual({
      channel,
      seen: "allowed",
    });
  const sha = "0".repeat(64);
  for (const [method, path] of [
    ["GET", `/v1/attachments/${thread}/${sha}/original`],
    ["POST", `/v1/attachments/${thread}/upload`],
    ["POST", "/v1/previews/3000/link"],
    ["POST", "/v1/pairings"],
    ["POST", "/v1/pair"],
  ] as const)
    expect({ path, seen: await http(home, method, path, token) }).toEqual({
      path,
      seen: "allowed",
    });
  // Its paired devices stay paired.
  const paired = await redeemPairing(await linkFrom(owner.client), "Phone");
  expect((await home.f.ticket(paired.token)).ticket).toEqual(expect.any(String));
  await home.close();
});
