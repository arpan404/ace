import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, test } from "vitest";
import { DeviceId, type ServerMessage, SpadeClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { createSpadeSession } from "./spade-session.ts";

/*
 * Turning Full access on is the person's alone (ADR 0163, amendment 2): the daemon forwards it to
 * Spade stamped as theirs only from a socket that proved the person's standing (ADR 0190), as
 * every person-only action needs, and going back to the auto-review from anyone who may change
 * Spade.
 */

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

/** A Spade that records what reaches it, and a session forwarding to it as `caller`. */
async function proxied(
  caller: { device: string; proven: boolean },
  onTestFinished: (close: () => Promise<void>) => void,
) {
  const seen: Seen[] = [];
  const spade = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => spade.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise((resolve) => spade.close(() => resolve())));
  const address = spade.address();
  if (!address || typeof address === "string") throw new Error("No port");
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
    device: () => DeviceId.parse(caller.device),
    personProven: () => caller.proven,
    now: () => 1_700_000_000_000,
  });
  const put = async (requestId: string, path: string, body: unknown) => {
    await service.handle?.(
      SpadeClientMessage.parse({
        type: "spade.http",
        requestId,
        method: "PUT",
        path,
        body: JSON.stringify(body),
      } satisfies z.input<typeof SpadeClientMessage>),
      DeviceId.parse(caller.device),
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
  const stampOf = (path: string) =>
    seen.find((request) => request.path === path)?.headers["x-ace-person"];
  return { put, seen, stampOf, close: () => service.close?.() };
}

const bot = "/v1/agents/a_1/security/autonomy";
const machine = "/v1/security/autonomy";

test("a socket that proved the person's standing turns Full access on with their stamp, for a bot and the machine", async ({
  onTestFinished,
}) => {
  const spade = await proxied({ device: "phone", proven: true }, (close) => onTestFinished(close));
  expect(await spade.put("b", bot, { autonomy: "full_access" })).toMatchObject({ status: 200 });
  expect(spade.stampOf(bot)).toMatch(/^v1\.1700000000000\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  expect(await spade.put("m", machine, { autonomy: "full_access" })).toMatchObject({
    status: 200,
  });
  expect(spade.stampOf(machine)).toMatch(/^v1\./);
  spade.close();
});

test("a credential that hasn't proved the person's standing never turns Full access on, whoever holds it", async ({
  onTestFinished,
}) => {
  // The host token (which a recent sign-in no longer helps), and a paired device's bearer token
  // without its key's proof: both unproven.
  for (const device of ["cli", "phone"]) {
    const unproven = await proxied({ device, proven: false }, (close) => onTestFinished(close));
    for (const [path, body] of [
      [bot, { autonomy: "full_access" }],
      [bot, { autonomy: null }],
      [machine, { autonomy: "full_access" }],
    ] as const)
      expect(await unproven.put(path + JSON.stringify(body), path, body)).toMatchObject({
        kind: "error",
        code: "forbidden",
        message: "Confirm your identity to continue.",
      });
    expect(unproven.seen).toEqual([]);
    // Going back to the auto-review never needs it, and carries no stamp.
    expect(await unproven.put("down", bot, { autonomy: "auto_review" })).toMatchObject({
      status: 200,
    });
    expect(unproven.seen).toHaveLength(1);
    expect(unproven.stampOf(bot)).toBeUndefined();
    unproven.close();
  }
});

test("an agent's device never turns Full access on, but may turn it off", async ({
  onTestFinished,
}) => {
  for (const device of ["ace-agent", "ace-reviewer"]) {
    const agent = await proxied({ device, proven: true }, (close) => onTestFinished(close));
    expect(await agent.put("up", bot, { autonomy: "full_access" })).toMatchObject({
      kind: "error",
      code: "forbidden",
    });
    expect(await agent.put("m", machine, { autonomy: "full_access" })).toMatchObject({
      kind: "error",
      code: "forbidden",
    });
    expect(agent.seen).toEqual([]);
    expect(await agent.put("down", bot, { autonomy: "auto_review" })).toMatchObject({
      status: 200,
    });
    expect(agent.stampOf(bot)).toBeUndefined();
    agent.close();
  }
});
