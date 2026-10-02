import { expect, test } from "vitest";
import { DeviceId, SocketTicket, WorkspaceId, ThreadId } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { fixture } from "./socket-test-support.ts";

test("history requires authentication and read-only devices cannot scan import or continue", async () => {
  const f = await fixture({
    history: {
      async handle(request) {
        if (request.type === "history.list")
          return { type: "history.list", sessions: [], next: null };
        throw new Error("unexpected operate request");
      },
    },
  });
  try {
    const unauthenticated = await f.open();
    unauthenticated.send({ type: "history.list", cwd: "/repo", limit: 50 });
    expect(await unauthenticated.next()).toMatchObject({ type: "error", code: "unauthorized" });
    const credentials = f.store.devices.create("Read only", ["read"], 1);
    const ticket = SocketTicket.parse(
      await accessRequest(f.server.httpUrl, "/v1/tickets", {
        method: "POST",
        token: credentials.token,
      }),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(credentials.device.id),
      ticket: ticket.ticket,
    });
    expect((await client.next()).type).toBe("welcome");
    client.send({ type: "history.list", cwd: "/repo", limit: 50 });
    expect(await client.next()).toMatchObject({ type: "history.list", sessions: [] });
    client.send({ type: "history.scan" });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    client.send({
      type: "history.import",
      sourceId: "source",
      workspaceId: WorkspaceId.parse("workspace"),
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    client.send({
      type: "history.continue",
      threadId: ThreadId.parse("thread"),
      mode: "resume",
      input: [],
      delivery: "queue",
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
  } finally {
    await f.close();
  }
});
