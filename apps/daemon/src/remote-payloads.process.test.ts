import { expect, it } from "vitest";
import { shell, message } from "./payload-test-support.ts";
import { setup } from "./remote-test-support.ts";

it.each(["output", "items"])(
  "requires read scope for ticket-authenticated %s retrieval",
  async (kind) => {
    const f = await setup();
    const item = shell();
    f.store.appendEvents(f.thread.id, [
      { type: "item.created", item },
      { type: "item.created", item: message("m", "private") },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "output",
        append: "private output",
      },
    ]);
    for (const granted of [["operate"], ["read"], ["admin"]]) {
      const paired = await f.pair(granted);
      const ticket = await f.ticket(paired.token);
      const client = await f.connectTicket(paired.device.id, ticket.ticket);
      expect(await client.next()).toMatchObject({ type: "welcome" });
      if (kind === "output")
        client.send({
          type: "output.read",
          requestId: "r",
          streamId: "output:shell",
          offset: 0,
          limit: 100,
        });
      else
        client.send({
          type: "items.page",
          requestId: "r",
          threadId: f.thread.id,
          before: f.store.headSeq() + 1,
          limit: 10,
        });
      const response = await client.next();
      if (granted.includes("operate"))
        expect(response).toMatchObject({ type: "error", code: "forbidden" });
      else if (kind === "output")
        expect(response).toMatchObject({
          type: "output.data",
          bytes: Buffer.from("private output").toString("base64"),
        });
      else
        expect(response).toMatchObject({
          type: "items.page",
          items: expect.arrayContaining([
            expect.objectContaining({ id: "m", parts: [{ type: "text", text: "private" }] }),
          ]),
        });
      client.send({ type: "ping" });
      expect(await client.next()).toEqual({ type: "pong" });
    }
  },
);
