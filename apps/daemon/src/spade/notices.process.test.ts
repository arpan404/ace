import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { ThreadId, type Notification } from "@ace/protocol";
import { spadeLive } from "./forward.ts";
import type { SpadeReady } from "./link.ts";
import { followSpadeNotices } from "./notices.ts";

/*
 * The wiring against a real local HTTP server speaking Spade's notice stream: what Spade sends
 * to reach the person now reaches the worker once, and a stream Spade closes is opened again.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function fakeSpade() {
  const streams: ServerResponse[] = [];
  let opened = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/notices/live" || request.headers.authorization !== "Bearer t") {
      response.writeHead(404).end();
      return;
    }
    opened++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\n");
    streams.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.destroy();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    ready: { connection: { host: "127.0.0.1", port, token: "t" }, generation: 1 } satisfies SpadeReady,
    opened: () => opened,
    send(notice: Record<string, unknown>) {
      streams.at(-1)?.write(`event: notice\ndata: ${JSON.stringify(notice)}\n\n`);
    },
    closeStream() {
      streams.at(-1)?.end();
    },
  };
}

const until = async (test: () => boolean) => {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(test()).toBe(true);
};

it("what Spade sends to reach the person now reaches ace's alerts, and a closed stream reopens", async () => {
  const spade = await fakeSpade();
  const alerts: Notification[] = [];
  const follower = followSpadeNotices({
    ready: () => spade.ready,
    onReady: () => () => {},
    hostThread: () => ThreadId.parse("spade-host"),
    notify: async (notification) => {
      alerts.push(notification);
    },
    live: spadeLive,
    after: (ms, run) => {
      const timer = setTimeout(run, Math.min(ms, 20));
      return () => clearTimeout(timer);
    },
    report: (error) => {
      throw error;
    },
  });
  stops.push(() => follower.close());
  await until(() => spade.opened() === 1);
  const base = { kind: "event", agent: "a1", name: "Booker", conversation: "c1", category: "needs_you" };
  spade.send({ ...base, id: "event:c1:1", text: "Held", reach: "held", why: "dnd" });
  spade.send({ ...base, id: "event:c1:2", text: "Asks: Window or aisle?", reach: "now", request: "q2" });
  await until(() => alerts.length === 1);
  expect(alerts[0]?.id).toBe("spade:event:c1:2");
  expect(alerts[0]?.spade?.request).toBe("q2");

  spade.closeStream();
  await until(() => spade.opened() === 2);
  spade.send({ ...base, id: "event:c1:3", text: "Its reply failed.", reach: "now", category: "escalation" });
  await until(() => alerts.length === 2);
  expect(alerts.map((alert) => alert.id)).toEqual(["spade:event:c1:2", "spade:event:c1:3"]);
});
