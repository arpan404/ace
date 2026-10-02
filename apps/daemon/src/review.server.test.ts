import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Command } from "@ace/protocol";
import { createDaemonReview } from "./review.ts";
import { fixture } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

it("routes authenticated review reads through the worker and rejects unregistered repositories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-review-server-"));
  let review: ReturnType<typeof createDaemonReview> | undefined;
  const f = await fixture({
    review: {
      handle: (command) => {
        if (!review) throw new Error("Missing review");
        return review.handle(command);
      },
    },
  });
  review = createDaemonReview(dir, f.store);
  try {
    const client = await f.connect();
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({ id: "list", deviceId: "device", payload: { type: "review.list" } }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: true,
      review: { sessions: [] },
    });
    client.send({
      type: "command",
      command: Command.parse({
        id: "open",
        deviceId: "device",
        payload: {
          type: "review.open",
          source: {
            workspaceId: "missing",
            from: { kind: "commit", ref: "HEAD" },
            to: { kind: "working-tree" },
          },
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: false,
      error: "review_workspace_not_found",
    });
  } finally {
    await review.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("a read-only paired device can list reviews but cannot change their status", async () => {
  const f = await setup({
    review: {
      async handle(command) {
        return { commandId: command.id, ok: true, review: { sessions: [] } };
      },
    },
  });
  const credential = await f.pair(["read"]);
  const ticket = await f.ticket(credential.token);
  const client = await f.connectTicket(credential.device.id, ticket.ticket);
  await client.next();
  client.send({
    type: "command",
    command: Command.parse({
      id: "read",
      deviceId: credential.device.id,
      payload: { type: "review.list" },
    }),
  });
  expect(await client.next()).toMatchObject({
    type: "commandResult",
    ok: true,
    review: { sessions: [] },
  });
  client.send({
    type: "command",
    command: Command.parse({
      id: "mutate",
      deviceId: credential.device.id,
      payload: { type: "review.status", sessionId: "session", status: "approved" },
    }),
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
});
