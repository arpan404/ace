import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, test } from "vitest";
import { DeviceId, type ServerMessage, SpadeClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { orgStanding } from "../account-access/org-socket.ts";
import { createSpadeSession } from "./spade-session.ts";

/*
 * A member's answer to a shared bot's request on an organization's host (ADR 0206 §6, §8.1):
 * the daemon stamps it only while the member's standing is current, and a standing proven more
 * than 60 seconds ago is checked with the account backend first. A check that says no, or that
 * can't be made, refuses the answer before it reaches Spade. The host's audit log is read only by
 * a member whose role allows `audit:read`, on the same checked standing.
 */

const T0 = 1_800_000_000_000;
const gus = { org: "org_01ACME", role: "member", account: "user_gus" };
const approval = "/v1/conversations/c1/approvals/call1";

async function orgHostSession(
  answers: (grant: string) => Promise<{ current: boolean; role?: string }>,
  onTestFinished: (close: () => Promise<void>) => void,
  role = gus.role,
  hostCredential = false,
) {
  let clock = T0;
  const asked: string[] = [];
  const seen: IncomingHttpHeaders[] = [];
  const spade = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push(request.headers);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => spade.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise((resolve) => spade.close(() => resolve())));
  const address = spade.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const standing = orgStanding({
    now: () => clock,
    holds: () => true,
    recheck: (grant) => {
      asked.push(grant);
      return answers(grant);
    },
  });
  /** Proves `grant`, issued at `issuedAt`, on the socket, as each `account.standing` does. */
  const prove = (issuedAt = T0, grant = "grant-gus") =>
    standing.prove({
      until: issuedAt + 300_000,
      generation: 1,
      member: { ...gus, role },
      grant,
      issuedAt,
    });
  prove();
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port: address.port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
        personKey: () => new Uint8Array(32).fill(7),
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
    device: () => DeviceId.parse("phone"),
    orgHost: () => true,
    hostCredential: () => hostCredential,
    memberStanding: () => standing.current(),
    memberStandingChecked: () => standing.checked(),
    now: () => clock,
  });
  onTestFinished(async () => service.close?.());
  let requests = 0;
  const send = async (request: { method: "GET" | "POST"; path: string; body?: string }) => {
    const requestId = `request-${++requests}`;
    await service.handle?.(
      SpadeClientMessage.parse({
        type: "spade.http",
        requestId,
        ...request,
      } satisfies z.input<typeof SpadeClientMessage>),
      DeviceId.parse("phone"),
    );
    for (let tries = 0; tries < 200; tries++) {
      const found = sent.find(
        (message) => message.type === "spade.http.result" && message.requestId === requestId,
      );
      if (found?.type === "spade.http.result") return found.result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No result for ${requestId}`);
  };
  const answer = () =>
    send({ method: "POST", path: approval, body: JSON.stringify({ allowed: true }) });
  const readAudit = () => send({ method: "GET", path: "/v1/org/audit/export" });
  return {
    answer,
    readAudit,
    prove,
    asked,
    seen,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("an older standing is checked first, and a member the backend no longer has can't answer", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(async () => ({ current: false }), onTestFinished);
  host.advance(61_000);
  expect(await host.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(host.asked).toEqual(["grant-gus"]);
  expect(host.seen).toEqual([]);
  // Their standing is gone: the next answer is refused without asking again.
  expect(await host.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(host.asked).toHaveLength(1);
});

test("a check that can't be made, or that names another role, refuses the answer", async ({
  onTestFinished,
}) => {
  const unreachable = await orgHostSession(async () => {
    throw new Error("offline");
  }, onTestFinished);
  unreachable.advance(61_000);
  expect(await unreachable.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(unreachable.seen).toEqual([]);

  const demoted = await orgHostSession(
    async () => ({ current: true, role: "org_viewer" }),
    onTestFinished,
  );
  demoted.advance(61_000);
  expect(await demoted.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(demoted.seen).toEqual([]);
});

test("a standing the backend confirms answers, and isn't asked about again for a minute", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(
    async () => ({ current: true, role: "member" }),
    onTestFinished,
  );
  host.advance(61_000);
  expect(await host.answer()).toMatchObject({ status: 200 });
  host.advance(30_000);
  expect(await host.answer()).toMatchObject({ status: 200 });
  expect(host.asked).toEqual(["grant-gus"]);
  expect(host.seen).toHaveLength(2);
  expect(host.seen.map((headers) => headers["x-ace-member"])).toEqual([
    expect.stringMatching(/^v1\./),
    expect.stringMatching(/^v1\./),
  ]);
});

test("proving the same grant again doesn't start the minute over", async ({ onTestFinished }) => {
  const host = await orgHostSession(async () => ({ current: false }), onTestFinished);
  host.advance(61_000);
  // The same unexpired grant, presented again on the socket.
  host.prove();
  expect(await host.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(host.asked).toEqual(["grant-gus"]);
  // Refused once, the same grant proved again is asked about again, never taken as fresh.
  host.prove();
  expect(await host.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(host.asked).toEqual(["grant-gus", "grant-gus"]);
  expect(host.seen).toEqual([]);
});

test("a grant issued more than a minute before it is proven is checked on its first answer", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(async () => ({ current: false }), onTestFinished);
  host.advance(10_000);
  host.prove(T0 - 61_000 + 10_000 - 1);
  expect(await host.answer()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(host.asked).toEqual(["grant-gus"]);
});

test("a grant's confirmation lasts its minute however many other grants are confirmed meanwhile", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(
    async () => ({ current: true, role: "member" }),
    onTestFinished,
  );
  host.advance(61_000);
  expect(await host.answer()).toMatchObject({ status: 200 });
  // Nine more grants proven on the socket since, each confirmed by the backend in turn.
  for (let other = 1; other <= 9; other++) {
    host.prove(T0, `grant-${other}`);
    expect(await host.answer()).toMatchObject({ status: 200 });
  }
  expect(host.asked).toHaveLength(10);
  // The first grant again, still inside the minute since it was confirmed: no need to ask.
  host.advance(10_000);
  host.prove(T0);
  expect(await host.answer()).toMatchObject({ status: 200 });
  expect(host.asked).toHaveLength(10);
});

test("a member's read of the host's audit log is refused before it reaches Spade", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(
    async () => ({ current: true, role: "member" }),
    onTestFinished,
  );

  expect(await host.readAudit()).toMatchObject({
    kind: "error",
    code: "forbidden",
    message: "Only your organization's admins can read its audit log.",
  });
  expect(host.seen).toEqual([]);
});

test("an admin reads the host's audit log, and an admin the backend no longer has can't", async ({
  onTestFinished,
}) => {
  const admin = await orgHostSession(
    async () => ({ current: true, role: "admin" }),
    onTestFinished,
    "admin",
  );
  expect(await admin.readAudit()).toMatchObject({ status: 200 });
  expect(admin.seen).toHaveLength(1);

  const removed = await orgHostSession(async () => ({ current: false }), onTestFinished, "admin");
  removed.advance(61_000);
  expect(await removed.readAudit()).toMatchObject({ kind: "error", code: "forbidden" });
  expect(removed.asked).toEqual(["grant-gus"]);
  expect(removed.seen).toEqual([]);
});

test("the host's own command line reads its audit log without a member's standing", async ({
  onTestFinished,
}) => {
  const host = await orgHostSession(
    async () => ({ current: false }),
    onTestFinished,
    "member",
    true,
  );
  host.advance(61_000);

  expect(await host.readAudit()).toMatchObject({ status: 200 });
  expect(host.asked).toEqual([]);
});
