import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProjectsRequest, type ProjectsResult } from "@ace/protocol";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";
import type { Client } from "./socket-test-support.ts";

let sequence = 0;
async function read(
  client: Client,
  operation: ProjectsRequest["operation"],
): Promise<ProjectsResult["result"]> {
  const requestId = `picker-review-${++sequence}`;
  client.send(ProjectsRequest.parse({ type: "projects.request", requestId, operation }));
  const reply = await until(
    client,
    (message) => message.type === "projects.result" && message.requestId === requestId,
  );
  if (reply.type !== "projects.result") throw new Error("Expected project response");
  return reply.result;
}

test("a deleted first-ranked cached folder does not hide the next valid search result", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "alpha-one"));
    await mkdir(join(f.root, "alpha-two"));
    const client = await server.connect();
    const operation = { op: "fs.search" as const, query: "alpha", limit: 1, showHidden: false };
    expect(await read(client, operation)).toMatchObject({ entries: [{ name: "alpha-one" }] });
    await rm(join(f.root, "alpha-one"), { recursive: true });
    expect(await read(client, operation)).toMatchObject({ entries: [{ name: "alpha-two" }] });
  } finally {
    await server.close();
    await f.close();
  }
});

test("completion aliases cannot expose ignored targets or hidden targets in default mode", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    for (const name of ["Library", ".git", ".hidden", "visible"]) await mkdir(join(f.root, name));
    await symlink(join(f.root, "Library"), join(f.root, "alias-library"));
    await symlink(join(f.root, ".git"), join(f.root, "alias-git"));
    await symlink(join(f.root, ".hidden"), join(f.root, "alias-hidden"));
    await symlink(join(f.root, "visible"), join(f.root, "alias-visible"));
    const client = await server.connect();
    const input = {
      op: "fs.complete" as const,
      path: `${f.root}/alias-`,
      limit: 100,
      showHidden: false,
    };
    expect(await read(client, input)).toMatchObject({
      candidates: [
        {
          name: "alias-visible",
          completion: `${f.root}/alias-visible/`,
          path: join(f.root, "visible"),
        },
      ],
      commonPrefix: `${f.root}/alias-visible/`,
    });
    const hidden = await read(client, { ...input, showHidden: true });
    if (hidden.kind !== "completion") throw new Error("Expected completion");
    expect(hidden.candidates.map((entry) => entry.name)).toEqual(["alias-hidden", "alias-visible"]);
  } finally {
    await server.close();
    await f.close();
  }
});

test("completion bounds metadata work when every matching symlink has an ignored target", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    const allowed = join(f.root, "allowed");
    await mkdir(allowed);
    // These links point to an allowed directory but an ignored canonical target, so every
    // entry is rejected and cannot count toward the successful-candidate bound.
    const ignored = join(allowed, "Library");
    await mkdir(ignored);
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        symlink(ignored, join(allowed, `alias-${String(index).padStart(4, "0")}`)),
      ),
    );
    const client = await server.connect();
    expect(
      await read(client, {
        op: "fs.complete",
        path: `${allowed}/alias-`,
        limit: 100,
        showHidden: false,
      }),
    ).toMatchObject({
      candidates: [],
      truncated: true,
      commonPrefix: `${allowed}/alias-`,
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("completion bounds matching regular files before later folder candidates", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(join(f.root, `item-${String(index).padStart(4, "0")}`), ""),
      ),
    );
    await mkdir(join(f.root, "item-folder"));
    const client = await server.connect();
    expect(
      await read(client, { op: "fs.complete", path: "~/item-", limit: 100, showHidden: false }),
    ).toMatchObject({
      candidates: [],
      truncated: true,
      commonPrefix: "~/item-",
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("completion never inserts half of a Unicode character as the common prefix", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "😀-one"));
    await mkdir(join(f.root, "😁-two"));
    const client = await server.connect();
    expect(
      await read(client, { op: "fs.complete", path: "~/", limit: 100, showHidden: false }),
    ).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ completion: "~/😀-one/" }),
        expect.objectContaining({ completion: "~/😁-two/" }),
      ]),
      commonPrefix: "~/",
      truncated: false,
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("concurrent sockets retain independent visible and hidden search snapshots", async () => {
  let root = "";
  let armed = false;
  let waiting = 0;
  const admission = Promise.withResolvers<void>();
  const f = await projectFixture({
    pickerClock: () => 1000,
    roots: async () => {
      // Synchronize the two public requests at the injected host-settings boundary.
      if (armed && waiting < 2) {
        waiting++;
        if (waiting === 2) admission.resolve();
        await admission.promise;
      }
      return [root];
    },
  });
  root = f.root;
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "visible-project"));
    await mkdir(join(f.root, ".hidden-project"));
    const normal = await server.connect();
    const hidden = await server.connect({ deviceId: "other-window" });
    armed = true;
    const normalInput = {
      op: "fs.search" as const,
      query: "project",
      limit: 100,
      showHidden: false,
    };
    const hiddenInput = { ...normalInput, showHidden: true };
    const initial = await Promise.all([read(normal, normalInput), read(hidden, hiddenInput)]);
    // One request owns the scan; the other may return a partial view. The completed scan
    // must not claim that a pending index belonging to the other socket is its own.
    expect(initial.some((result) => result.kind === "search" && !result.indexing)).toBe(true);
    const normalFirst = initial[0];
    const hiddenFirst = initial[1];
    if (normalFirst?.kind !== "search" || hiddenFirst?.kind !== "search")
      throw new Error("Expected search");
    const normalResult = normalFirst.indexing ? await read(normal, normalInput) : normalFirst;
    const hiddenResult = hiddenFirst.indexing ? await read(hidden, hiddenInput) : hiddenFirst;
    if (normalResult.kind !== "search") throw new Error("Expected search");
    expect(normalResult.indexing).toBe(false);
    expect(normalResult.entries.map((entry) => entry.name)).toContain("visible-project");
    expect(normalResult.entries.map((entry) => entry.name)).not.toContain(".hidden-project");
    expect(hiddenResult).toMatchObject({
      indexing: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: ".hidden-project" }),
        expect.objectContaining({ name: "visible-project" }),
      ]),
    });
  } finally {
    admission.resolve();
    await server.close();
    await f.close();
  }
});
