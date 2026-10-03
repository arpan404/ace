import { once } from "node:events";
import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { pinnedAgent } from "./client-access.ts";
import { Client } from "./socket-test-support.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";

test.each(["read", "operate"])(
  "search over pinned WSS requires read authority for a %s device",
  async (scope) => {
    const f = await setup();
    const item = Item.parse({
      id: "remoteitem",
      agentId: "agent",
      type: "message",
      role: "assistant",
      complete: true,
      createdAt: 1,
      parts: [{ type: "text", text: "remotesearchword" }],
    });
    f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
    const paired = await f.pair([scope]);
    const issued = await f.ticket(paired.token);
    const agent = pinnedAgent(identity.fingerprint);
    const client = new Client(f.server.remoteUrl, { agent });
    cleanups.push(
      () => agent.destroy(),
      () => client.close(),
    );
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: issued.ticket,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({
      type: "search.query",
      requestId: "remote",
      text: "remotesearchword",
      mode: "tokens",
      scope: "items",
      filters: {},
      limit: 30,
    });
    expect(await client.next()).toMatchObject(
      scope === "read"
        ? { type: "search.results", requestId: "remote", hits: [{ itemId: item.id }] }
        : { type: "error", code: "forbidden" },
    );
    client.send({ type: "search.status", requestId: "progress" });
    expect(await client.next()).toMatchObject(
      scope === "read"
        ? { type: "search.progress", ready: true }
        : { type: "error", code: "forbidden" },
    );
  },
);
