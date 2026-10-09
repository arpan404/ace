import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandLibrary } from "@ace/commands";
import { DeviceId, WorkspaceId } from "@ace/protocol";
import { startServer } from "./server.ts";
import { Client } from "./socket-test-support.ts";
import { harness, scriptFrames, start, end } from "./engine/test-support.ts";
const token = "a".repeat(64);

test("an authenticated subscriber receives file catalog replacements scoped to its thread", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "cursor",
  });
  const root = await realpath(h.home);
  const directory = join(root, ".cursor/skills/review");
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, "provider/skills/review-user"), { recursive: true });
  await writeFile(
    join(root, "provider/skills/review-user/SKILL.md"),
    "---\nname: review-user\ndescription: Review prose\n---\nBody",
  );
  const file = join(directory, "SKILL.md");
  await writeFile(file, "---\nname: review\ndescription: Review the project\n---\nBody");
  const library = new CommandLibrary({
    aceHome: root,
    instances: [{ id: "cursor-personal", provider: "cursor", home: join(root, "provider") }],
    context: () => ({ workspace: root, provider: "cursor", instance: "cursor-personal" }),
    now: () => h.clock.now(),
  });
  const server = await startServer({
    port: 0,
    token,
    hostId: "catalog-test",
    store: h.store,
    handler: h.engine.handler,
    engine: h.engine,
    commands: library,
  });
  const client = new Client(server.url);
  try {
    await once(client.socket, "open");
    const id = await h.create();
    await library.list(id, "", 100);
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("catalog-reader"),
      token,
    });
    expect((await client.next()).type).toBe("welcome");
    client.send({
      type: "catalog.list",
      requestId: "extensions",
      threadId: id,
      subscribe: true,
      query: "review",
      limit: 100,
    });
    const snapshot = await client.next();
    expect(snapshot).toMatchObject({
      type: "catalog.list.result",
      requestId: "extensions",
      stale: false,
    });
    if (snapshot.type !== "catalog.list.result") throw new Error("Missing snapshot");
    expect(
      snapshot.entries.find((e) => e.kind === "skill" && e.source.scope === "project"),
    ).toMatchObject({
      source: { scope: "project", provider: "cursor" },
      description: "Review the project",
    });
    expect(
      snapshot.entries.find((e) => e.source.scope === "global" && e.kind === "skill"),
    ).toMatchObject({ name: "review-user", description: "Review prose" });
    const workspaceId = h.store.getThread(id)?.workspaceId;
    if (!workspaceId) throw new Error("Missing workspace");
    client.send({
      type: "catalog.list",
      requestId: "skills-page",
      subscribe: false,
      workspace: { workspaceId, provider: "cursor" },
      query: "review",
      limit: 100,
    });
    const workspaceCatalog = await client.next();
    expect(workspaceCatalog).toMatchObject({
      type: "catalog.list.result",
      entries: snapshot.entries,
      stale: false,
    });
    client.send({
      type: "catalog.list",
      requestId: "missing-project",
      subscribe: false,
      workspace: { workspaceId: WorkspaceId.parse("missing"), provider: "cursor" },
      query: "",
      limit: 100,
    });
    expect(await client.next()).toMatchObject({
      type: "error",
      requestId: "missing-project",
      code: "catalog_unavailable",
    });
    await writeFile(file, "---\nname: review\ndescription: Changed project review\n---\nNew body");
    for (;;) {
      const changed = await client.next();
      if (
        changed.type === "catalog.changed" &&
        changed.entries.some((e) => e.description === "Changed project review")
      ) {
        expect(changed.requestId).toBe("extensions");
        expect(changed.entries.some((e) => e.description === "Review the project")).toBe(false);
        break;
      }
    }
    client.send({ type: "catalog.unsubscribe", requestId: "extensions" });
  } finally {
    await client.close();
    await server.close();
    await library.close();
    await h.close();
  }
});

test("cold composer and Skills subscribers receive discovery without another list request", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "cursor",
  });
  const root = await realpath(h.home);
  const metadata = Promise.withResolvers<import("@ace/protocol").CatalogEntry[]>();
  const library = new CommandLibrary({
    aceHome: root,
    instances: [{ id: "cursor-personal", provider: "cursor", home: join(root, "provider") }],
    context: () => ({ workspace: root, provider: "cursor", instance: "cursor-personal" }),
    now: () => h.clock.now(),
    extras: () => metadata.promise,
  });
  const server = await startServer({
    port: 0,
    token,
    hostId: "cold-catalog",
    store: h.store,
    handler: h.engine.handler,
    engine: h.engine,
    commands: library,
  });
  const client = new Client(server.url);
  try {
    await once(client.socket, "open");
    const threadId = await h.create();
    const workspaceId = h.store.getThread(threadId)?.workspaceId;
    if (!workspaceId) throw new Error("Missing workspace");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("cold-reader"),
      token,
    });
    await client.next();
    for (const requestId of ["composer", "skills"]) {
      client.send({
        type: "catalog.list",
        requestId,
        query: "",
        subscribe: true,
        limit: 100,
        ...(requestId === "composer"
          ? { threadId }
          : { workspace: { workspaceId, provider: "cursor" as const } }),
      });
      for (;;) {
        const reply = await client.next();
        if (reply.type !== "catalog.list.result" || reply.requestId !== requestId) continue;
        expect(reply.stale).toBe(true);
        expect(reply.entries.some((entry) => entry.name === "Review changes")).toBe(false);
        break;
      }
    }
    metadata.resolve([
      {
        id: "review",
        kind: "skill",
        name: "Review changes",
        description: "Review project changes",
        source: { provider: "cursor", scope: "global" },
        invocation: {
          type: "skill",
          name: "review",
          path: join(root, "provider/skills/review/SKILL.md"),
        },
      },
    ]);
    const completed = new Set<string>();
    while (completed.size < 2) {
      const reply = await client.next();
      if (
        reply.type === "catalog.changed" &&
        !reply.stale &&
        reply.entries.some((entry) => entry.name === "Review changes")
      )
        completed.add(reply.requestId);
    }
    expect([...completed].toSorted()).toEqual(["composer", "skills"]);
  } finally {
    metadata.resolve([]);
    await client.close();
    await server.close();
    await library.close();
    await h.close();
  }
});
