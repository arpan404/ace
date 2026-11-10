import { expect, test } from "vitest";
import { Client } from "@ace/client";
import {
  DeviceId,
  WorkspaceId,
  type ForgeRepository,
  type ForgeCapability,
  type ProjectRepositoryConfig,
} from "@ace/protocol";
import { FakeDaemon, fakeTransport, seedGitLabMirror } from "./index.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };

async function fixture(
  options: { mirror?: boolean; extraCapabilities?: ForgeCapability[] } = { mirror: true },
) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  if (options.mirror) seedGitLabMirror(daemon, 1000, options.extraCapabilities);
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
  return { client, daemon, workspaceId, read };
}

test("ace lists only its GitHub origin until its GitLab mirror is seeded", async () => {
  const f = await fixture({ mirror: false });
  try {
    const value = await f.read();
    expect(value?.repositories.map((entry) => entry.repository)).toEqual([github]);
  } finally {
    await f.client.close();
  }
});

test("a save from choices another device replaced is refused, and applies to the current ones", async () => {
  const f = await fixture();
  try {
    const set = (
      id: string,
      repositories: ProjectRepositoryConfig,
      expected: ProjectRepositoryConfig | null,
    ) =>
      f.client.command(
        { type: "workspace.repositories.set", workspaceId: f.workspaceId, repositories, expected },
        {},
        id,
      );
    const hide = { added: [], hidden: [gitlab], primary: null };
    expect(await set("web", hide, null)).toMatchObject({ ok: true });
    const add = { added: [{ ...github, name: "docs" }], hidden: [], primary: null };
    expect(await set("phone", add, null)).toMatchObject({
      ok: false,
      error: "repositories_changed",
    });
    expect((await f.read())?.config).toEqual(hide);
  } finally {
    await f.client.close();
  }
});

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

test.each([
  { extraCapabilities: [] },
  { extraCapabilities: ["reviews.comments.write", "issues.read"] },
] satisfies { extraCapabilities: ForgeCapability[] }[])(
  "mirror repositories and details agree on declared extra capabilities $extraCapabilities",
  async ({ extraCapabilities }) => {
    const f = await fixture({ mirror: true, extraCapabilities });
    try {
      const repositories = await f.read();
      const mirror = repositories?.repositories.find(
        (entry) => entry.repository.forge === "gitlab",
      );
      const expected = ["reviews.read", "reviews.files", ...extraCapabilities];
      expect(mirror?.capabilities).toEqual(expect.arrayContaining(expected));
      const reply = await f.client.request({
        type: "workspace.request",
        operation: {
          op: "forge.pr.detail",
          workspaceId: f.workspaceId,
          repository: gitlab,
          number: 17,
        },
      });
      expect(reply.result).toMatchObject({
        kind: "forge",
        data: { resource: "prDetail", value: { capabilities: expect.arrayContaining(expected) } },
      });
    } finally {
      await f.client.close();
    }
  },
);

test("a scripted detail with no capabilities keeps its explicit empty declaration", async () => {
  const f = await fixture();
  try {
    const operation = {
      op: "forge.pr.detail" as const,
      workspaceId: f.workspaceId,
      repository: gitlab,
      number: 17,
    };
    const first = await f.client.request({ type: "workspace.request", operation });
    if (first.result.kind !== "forge" || first.result.data.resource !== "prDetail")
      throw new Error("Expected a merge request detail");
    f.daemon.workspace.setForgeRead(operation, {
      resource: "prDetail",
      value: { ...first.result.data.value, capabilities: [] },
    });
    const next = await f.client.request({ type: "workspace.request", operation });
    expect(next.result).toMatchObject({
      kind: "forge",
      data: { resource: "prDetail", value: { capabilities: [] } },
    });
  } finally {
    await f.client.close();
  }
});
