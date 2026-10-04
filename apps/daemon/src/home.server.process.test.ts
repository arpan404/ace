import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";

test("home reports its display alias and canonical target alongside canonical project roots", async () => {
  const f = await projectFixture();
  const alias = join(f.root, "home-link");
  await symlink(f.root, alias);
  const linked = await projectFixture({ home: alias, roots: async () => [alias] });
  const server = await projectServer(linked);
  try {
    const client = await server.connect();
    client.send({ type: "projects.request", requestId: "home", operation: { op: "fs.home" } });
    expect(await until(client, (message) => message.type === "projects.result")).toMatchObject({
      result: { kind: "home", path: alias, canonicalPath: f.root, roots: [f.root] },
    });
  } finally {
    await server.close();
    await linked.close();
    await f.close();
  }
});
