import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { fakeGh, repository, issueRecord } from "@ace/forge/testing";
import { stubHandler } from "./commands.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { Client, token } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

// Real socket, SQLite and hosted CLI boundaries: the page loses its first successful receipt.
test("maintenance replay returns the admitted issue creation receipt instead of unsent evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-issue-socket-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const gh = await fakeGh({
    "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
    "repos/octo/ace/issues": [{ body: issueRecord }],
  });
  const runtime = new WorkspaceRuntime(store, join(root, "data"), () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  const server = await startServer({
    store,
    handler: stubHandler({ development: true }),
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    return client;
  };
  const command = Command.parse({
    id: "created-before-maintenance",
    deviceId: "device",
    payload: {
      type: "forge.issue.write",
      workspaceId,
      repository,
      input: { action: "create", title: "Only one issue", body: "Keep the original receipt" },
    },
  });
  try {
    const first = await connect();
    first.send({ type: "command", command });
    // The response is deliberately discarded without the client's durable acknowledgement.
    expect(await first.next()).toMatchObject({
      type: "commandResult",
      ok: true,
      issue: { number: 7 },
    });
    await first.close();
    server.maintenance.enter();
    const reconnected = await connect();
    reconnected.send({ type: "command", command });
    expect(await reconnected.next()).toMatchObject({
      type: "commandResult",
      commandId: command.id,
      ok: true,
      issueAction: { id: command.id, state: "succeeded" },
      issue: { number: 7 },
    });
    reconnected.send({
      type: "command",
      command: { ...command, id: Command.parse({ ...command, id: "fresh-refusal" }).id },
    });
    expect(await reconnected.next()).toMatchObject({
      type: "commandResult",
      ok: false,
      code: "action_not_dispatched",
    });
    expect((await gh.requests()).filter((request) => request.args.includes("POST"))).toHaveLength(
      1,
    );
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

for (const state of ["pending", "uncertain", "succeeded"] as const) {
  test(`authorization refusal preserves a device's previously admitted ${state} issue receipt`, async () => {
    const f = await setup();
    try {
      const paired = await f.pair(["read"]);
      const command = Command.parse({
        id: `admitted-${state}`,
        deviceId: paired.device.id,
        payload: {
          type: "forge.issue.write",
          workspaceId: f.workspace,
          repository,
          input: { action: "create", title: "Already admitted", body: "Original draft" },
        },
      });
      f.store.recordCommand(command.id, command.deviceId, () => ({
        commandId: command.id,
        ok: state === "succeeded",
        ...(state === "pending"
          ? { error: "client_action_pending" }
          : {
              issueAction: {
                id: command.id,
                action: "create",
                state,
                issue: { repository, number: 7 },
              },
              ...(state === "succeeded"
                ? { issue: { repository, number: 7 } }
                : { error: "forge_write_uncertain" }),
            }),
      }));
      const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
      await client.next();
      client.send({ type: "command", command });
      const result = await client.next();
      expect(result).toMatchObject({
        type: "commandResult",
        commandId: command.id,
        ok: state === "succeeded",
      });
      expect(result).not.toHaveProperty("code", "action_not_dispatched");
      if (state === "pending") expect(result).toHaveProperty("error", "action_outcome_uncertain");
      else expect(result).toHaveProperty("issueAction.state", state);
    } finally {
      await f.close();
    }
  });
}
