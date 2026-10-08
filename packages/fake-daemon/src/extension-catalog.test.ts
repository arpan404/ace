import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { Command, DeviceId, ThreadId, type ContentPart, type ServerMessage } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";
import { rootAgent } from "./scenarios/facts.ts";
async function connect(daemon: FakeDaemon) {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("catalog-device"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  await client.start();
  await ready.promise;
  stop();
  return client;
}
test("fake catalogs distinguish providers, projects and scopes over the client protocol", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  for (const provider of ["claude", "codex", "opencode", "cursor", "pi", "acp"] as const)
    daemon.createThread({ id: provider, workspaceId: "project", provider, title: provider });
  daemon.createThread({
    id: "another",
    workspaceId: "another-project",
    provider: "codex",
    title: "Other",
  });
  const client = await connect(daemon);
  try {
    for (const provider of ["claude", "codex", "opencode", "cursor", "pi", "acp"] as const) {
      const result = await client.request({
        type: "catalog.list",
        threadId: ThreadId.parse(provider),
        limit: 512,
      });
      expect(result.entries.some((e) => e.kind === "skill" && e.source.scope === "project")).toBe(
        true,
      );
      expect(result.entries.some((e) => e.kind === "skill" && e.source.scope === "global")).toBe(
        true,
      );
      expect(result.entries.some((e) => e.kind === "workflow" && e.source.provider === "ace")).toBe(
        true,
      );
      expect(
        result.entries
          .filter((e) => e.source.provider !== "ace")
          .every((e) => e.source.provider === provider),
      ).toBe(true);
    }
    const first = await client.request({ type: "catalog.list", threadId: ThreadId.parse("codex") });
    const other = await client.request({
      type: "catalog.list",
      threadId: ThreadId.parse("another"),
    });
    expect(first.entries.find((e) => e.source.scope === "project")?.id).not.toBe(
      other.entries.find((e) => e.source.scope === "project")?.id,
    );
    expect(first.entries.find((e) => e.name === "Google Drive")).toMatchObject({
      kind: "plugin",
      invocation: { type: "mention", path: "app://fixture-google-drive" },
    });
  } finally {
    await client.close();
  }
});
test("fake catalog subscriptions push replacement definitions and stop after unsubscribe", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "thread", workspaceId: "project", provider: "codex", title: "Work" });
  const client = await connect(daemon);
  const pushes: ServerMessage[] = [];
  const changed = Promise.withResolvers<void>();
  const stop = client.onMessage((m) => {
    if (m.type === "catalog.changed") {
      pushes.push(m);
      changed.resolve();
    }
  });
  try {
    const initial = await client.request(
      { type: "catalog.list", threadId: ThreadId.parse("thread"), subscribe: true },
      { requestId: "catalog-watch" },
    );
    const skill = initial.entries.find((e) => e.kind === "skill");
    if (!skill) throw new Error("Missing fake skill");
    daemon.seedServices({
      extensionCatalogs: { codex: [{ ...skill, description: "Changed project skill" }] },
    });
    await changed.promise;
    expect(pushes).toMatchObject([
      {
        type: "catalog.changed",
        requestId: "catalog-watch",
        entries: expect.arrayContaining([
          { ...skill, description: "Changed project skill" },
          expect.objectContaining({
            name: "explain",
            source: { provider: "ace", scope: "global" },
          }),
        ]),
      },
    ]);
    // A subsequent correlated read is the delivery barrier for the unsubscribe.
    client.send({ type: "catalog.unsubscribe", requestId: "catalog-watch" });
    await client.request({ type: "catalog.list", threadId: ThreadId.parse("thread") });
    daemon.seedServices({ extensionCatalogs: { codex: [] } });
    expect(pushes).toHaveLength(1);
  } finally {
    stop();
    await client.close();
  }
});
test("the fake transcript keeps multiple mention chips in their original positions", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "thread", workspaceId: "project", provider: "codex", title: "Work" });
  daemon.apply("thread", [rootAgent("codex", "/fixture/project")]);
  const parts: ContentPart[] = [
    { type: "text", text: "Use " },
    {
      type: "mention",
      entryId: "codex:project:skill:review",
      name: "review",
      kind: "skill",
      arguments: "",
    },
    { type: "text", text: " with " },
    {
      type: "mention",
      entryId: "codex:app:drive",
      name: "Google Drive",
      kind: "plugin",
      arguments: "",
    },
  ];
  expect(
    daemon.command(
      Command.parse({
        id: "send",
        deviceId: "catalog-device",
        payload: { type: "thread.send", threadId: "thread", input: parts },
      }),
    ).ok,
  ).toBe(true);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread") });
  if (!view || view.kind !== "thread") throw new Error("Missing thread view");
  expect(
    Object.values(view.items).filter((i) => i.type === "message" && i.role === "user"),
  ).toMatchObject([{ parts }]);
});
