import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { GRANT_LIFETIME_MS } from "@ace/account-grant";
import type { ServerMessage } from "@ace/protocol";
import type { SpadeAccess } from "./services/spade-session.ts";
import type { SpadeLink } from "./spade/link.ts";
import { deviceKey, person, useAccountBackend } from "./machine-standing-test-support.ts";
import { helloWith, mia, orgTeamHost, provesMember } from "./org-host-test-support.ts";

// ADR 0209 §4.2: a Spade request or live stream is bound to the member who opened it. When their
// standing lapses while Spade is still answering, nothing more of Spade's content reaches them.

const backend = useAccountBackend();
const lastMs = 1_500;

/** The next message, or a failure once `by` passes: a stream that never ends fails the test. */
async function next(
  client: { next(): Promise<ServerMessage> },
  by: number,
): Promise<ServerMessage> {
  const left = by - Date.now();
  if (left <= 0) throw new Error("Nothing ended it in time");
  const message = await Promise.race([
    client.next(),
    new Promise<undefined>((resolve) => setTimeout(resolve, left)),
  ]);
  if (!message) throw new Error("Nothing ended it in time");
  return message;
}

/** A Spade that answers each request only after `delayMs`, and streams a frame every 200 ms. */
async function slowSpade(delayMs: number) {
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    request.resume();
    if ((request.url ?? "").startsWith("/v1/org")) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if ((request.url ?? "").includes("/live")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      streams.add(response);
      response.on("close", () => streams.delete(response));
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ secret: "a shared bot's conversation" }));
    }, delayMs);
  });
  const ticker = setInterval(() => {
    for (const response of streams) response.write('event: message\ndata: {"n":1}\n\n');
  }, 200);
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
    spade: spade as unknown as SpadeLink,
    close: () => {
      clearInterval(ticker);
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Mia on the org host, her standing proven with a grant that runs out in `lastMs`. */
async function shortMember(spade: SpadeLink) {
  const team = await orgTeamHost(backend, { spade });
  const key = await deviceKey();
  const admitted = await helloWith(
    team.home,
    (await team.memberGrant(team.miaToken, key.raw)).token,
  );
  const last = backend.worker.mintMember(
    {
      org: team.org,
      role: "member",
      account: mia.id,
      subject: "phone",
      host: team.home.host,
      key: key.raw,
      policy: 0,
    },
    Date.now() - GRANT_LIFETIME_MS + lastMs,
  );
  expect((await provesMember(admitted.client, team.home.host, admitted.nonce, last, key)).ok).toBe(
    true,
  );
  return { team, client: admitted.client };
}

it("a Spade answer that comes after the member's standing lapsed is refused, not delivered", async () => {
  const slow = await slowSpade(lastMs + 1_000);
  const { team, client } = await shortMember(slow.spade);
  client.send({
    type: "spade.http",
    requestId: "late",
    method: "GET",
    path: "/v1/agents",
    encoding: "text",
  });
  const by = Date.now() + 8_000;
  for (;;) {
    const message = await next(client, by);
    if (Reflect.get(message, "requestId") !== "late") continue;
    // Never Spade's body: the standing it was asked under ended before the answer came.
    expect(JSON.stringify(message)).not.toContain("a shared bot's conversation");
    expect(message).toMatchObject({
      type: "spade.http.result",
      result: { kind: "error", code: "forbidden" },
    });
    break;
  }
  await team.home.close();
  await slow.close();
});

it("a live stream ends when the member's standing lapses, though Spade keeps sending", async () => {
  const slow = await slowSpade(0);
  const { team, client } = await shortMember(slow.spade);
  client.send({
    type: "spade.live.subscribe",
    requestId: "live",
    path: "/v1/conversations/c_1/live?after=0",
  });
  const frames: number[] = [];
  const by = Date.now() + 8_000;
  for (;;) {
    const message = await next(client, by);
    if (message.type === "spade.live.frame") frames.push(Date.now());
    if (message.type === "spade.live.ended" && message.requestId === "live") {
      expect(message.reason).toBe("forbidden");
      break;
    }
  }
  // Frames flowed while she stood, and none came after her standing ended.
  expect(frames.length).toBeGreaterThan(0);
  await team.home.close();
  await slow.close();
});

it("an upload opened by one member isn't continued by another proven later on the same socket", async () => {
  // The app on the host's own desktop proves Mia, opens an upload, then proves Pat.
  const slow = await slowSpade(0);
  const team = await orgTeamHost(backend, { spade: slow.spade });
  const page = await team.home.pageSocket();
  const prove = async (account: string, role: string) => {
    const key = await deviceKey();
    const grant = backend.worker.mintMember({
      org: team.org,
      role,
      account,
      subject: "device",
      host: team.home.host,
      key: key.raw,
      policy: 0,
    });
    expect((await provesMember(page.client, page.host, page.nonce, grant, key)).ok).toBe(true);
  };
  await prove(mia.id, "member");
  page.client.send({
    type: "spade.http",
    requestId: "upload",
    method: "POST",
    path: "/v1/conversations/c_1/messages",
    encoding: "text",
    contentType: "application/json",
    parts: 2,
  });
  const by = Date.now() + 8_000;
  for (;;) {
    const message = await next(page.client, by);
    if (message.type === "spade.http.open" && message.requestId === "upload") break;
  }
  await prove(person.id, "owner");
  page.client.send({ type: "spade.http.part", requestId: "upload", index: 0, body: '{"text":' });
  for (;;) {
    const message = await next(page.client, by);
    if (Reflect.get(message, "requestId") !== "upload") continue;
    expect(message).toMatchObject({
      type: "spade.http.result",
      result: { kind: "error", code: "forbidden" },
    });
    break;
  }
  await team.home.close();
  await slow.close();
});
