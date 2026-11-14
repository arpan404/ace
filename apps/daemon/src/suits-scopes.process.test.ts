import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { ServerMessage } from "@ace/protocol";
import { SuitServerMessage } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import { setup } from "./remote-test-support.ts";
import { SuitLibrary } from "./suits/library.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "./suits/watch.ts";

/*
 * A real paired-device socket: scope checks and the change push are wiring a unit test of the
 * library can't reach.
 */
const frame = z.union([ServerMessage, SuitServerMessage]);
type Frame = z.infer<typeof frame>;

test("a read device lists Suits and hears removals, but only an admin device removes one", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-suit-scopes-")));
  const root = join(home, "suits");
  await mkdir(join(root, "neon"), { recursive: true });
  await writeFile(
    join(root, "neon", "suit.json"),
    JSON.stringify({ format: 1, id: "neon", name: "Neon", dark: {} }),
  );
  const library = new SuitLibrary({
    root,
    key: new Uint8Array(32),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
    settleMs: 20,
  });
  await library.start();
  const sockets: WebSocket[] = [];
  try {
    const f = await setup({ suits: library });
    const connect = async (scopes: string[]) => {
      const device = await f.pair(scopes);
      const ticket = await f.ticket(device.token);
      const socket = new WebSocket(f.server.url);
      sockets.push(socket);
      const frames: Frame[] = [];
      const waiters: (() => void)[] = [];
      socket.on("message", (data) => {
        frames.push(frame.parse(JSON.parse(String(data))));
        for (const wake of waiters.splice(0)) wake();
      });
      const next = async (match: (message: Frame) => boolean): Promise<Frame> => {
        for (;;) {
          const found = frames.findIndex(match);
          if (found >= 0) return frames.splice(found, 1)[0]!;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      };
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          deviceId: device.device.id,
          ticket: ticket.ticket,
        }),
      );
      await next((message) => message.type === "welcome");
      const request = (requestId: string, body: unknown) => {
        socket.send(JSON.stringify({ type: "suitRequest", requestId, request: body }));
        return next((message) => "requestId" in message && message.requestId === requestId);
      };
      return { request, next };
    };

    const reader = await connect(["read"]);
    expect(await reader.request("list", { op: "list" })).toMatchObject({
      type: "suitResult",
      response: { op: "list", suits: [{ id: "neon", problems: [] }] },
    });
    expect(await reader.request("remove", { op: "remove", id: "neon" })).toMatchObject({
      response: { op: "error", code: "forbidden" },
    });
    expect((await stat(join(root, "neon"))).isDirectory()).toBe(true);

    const admin = await connect(["admin"]);
    expect(await admin.request("remove", { op: "remove", id: "neon" })).toMatchObject({
      response: { op: "remove", removed: true },
    });
    expect(await reader.next((message) => message.type === "suitsChanged")).toEqual({
      type: "suitsChanged",
      suits: [],
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    library.close();
    await rm(home, { recursive: true, force: true });
  }
});
