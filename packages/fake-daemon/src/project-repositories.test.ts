import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, WorkspaceId, type ForgeRepository } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "ace-thread", workspaceId: "ace", title: "A", provider: "codex" });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("laptop"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `req-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const workspaceId = WorkspaceId.parse("ace");
  const read = async () => {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "forge.repositories", workspaceId },
    });
    return reply.result.kind === "forge" && reply.result.data.resource === "repositories"
      ? reply.result.data.value
      : undefined;
  };
  return { client, workspaceId, read };
}

test("the seeded ace project uses its GitHub origin and its GitLab mirror, origin first", async () => {
  const f = await fixture();
  try {
    const value = await f.read();
    expect(
      value?.repositories.map(({ repository, remote, primary }) => ({
        repository,
        remote,
        primary,
      })),
    ).toEqual([
      { repository: github, remote: "origin", primary: true },
      { repository: gitlab, remote: "mirror", primary: false },
    ]);
    expect(value?.config).toBeNull();
  } finally {
    await f.client.close();
  }
});

test("choosing the mirror as primary and hiding origin is what the next read shows", async () => {
  const f = await fixture();
  try {
    const saved = await f.client.command(
      {
        type: "workspace.repositories.set",
        workspaceId: f.workspaceId,
        repositories: { added: [], hidden: [github], primary: gitlab },
      },
      {},
      "set",
    );
    expect(saved).toMatchObject({ ok: true });
    const value = await f.read();
    expect(value?.primary).toEqual(gitlab);
    expect(value?.repositories[0]).toMatchObject({ repository: github, visible: false });
    const refused = await f.client.command(
      {
        type: "workspace.repositories.set",
        workspaceId: f.workspaceId,
        repositories: { added: [], hidden: [gitlab], primary: gitlab },
      },
      {},
      "refuse",
    );
    expect(refused).toMatchObject({ ok: false, error: "primary_hidden" });
  } finally {
    await f.client.close();
  }
});
