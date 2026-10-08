import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandLibrary } from "@ace/commands";
import { DeviceId } from "@ace/protocol";
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
  await mkdir(join(root, "provider"));
  const file = join(directory, "SKILL.md");
  await writeFile(file, "---\nname: review\ndescription: Review the project\n---\nBody");
  const library = new CommandLibrary({
    aceHome: root,
    instances: [{ id: "cursor", provider: "cursor", home: join(root, "provider") }],
    context: () => ({ workspace: root, provider: "cursor", instance: "cursor" }),
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
    expect(snapshot.entries.find((e) => e.kind === "skill")).toMatchObject({
      source: { scope: "project", provider: "cursor" },
      description: "Review the project",
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
