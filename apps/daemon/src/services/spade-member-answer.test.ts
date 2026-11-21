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
 * can't be made, refuses the answer before it reaches Spade.
 */

const T0 = 1_800_000_000_000;
const gus = { org: "org_01ACME", role: "member", account: "user_gus" };
const approval = "/v1/conversations/c1/approvals/call1";

async function orgHostSession(
  answers: (grant: string) => Promise<{ current: boolean; role?: string }>,
  onTestFinished: (close: () => Promise<void>) => void,
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
    standing.prove({ until: issuedAt + 300_000, generation: 1, member: gus, grant, issuedAt });
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
    memberStanding: () => standing.current(),
    memberStandingChecked: () => standing.checked(),
    now: () => clock,
  });
  onTestFinished(async () => service.close?.());
  let requests = 0;
  const answer = async () => {
    const requestId = `answer-${++requests}`;
    await service.handle?.(
      SpadeClientMessage.parse({
        type: "spade.http",
        requestId,
        method: "POST",
        path: approval,
        body: JSON.stringify({ allowed: true }),
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
  return {
    answer,
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
