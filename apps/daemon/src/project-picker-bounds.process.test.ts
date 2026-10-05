import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProjectsRequest } from "@ace/protocol";
import { pickerFilesystem } from "./project-picker-filesystem.ts";
import {
  projectFixture,
  projectServer,
  pickerRead,
  finishPickerIndex,
  until,
} from "./projects-test-support.ts";

test("the directory admission cap excludes late siblings after a wide index finishes", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    for (let start = 0; start < 1100; start += 50)
      await Promise.all(
        Array.from({ length: Math.min(50, 1100 - start) }, (_, offset) =>
          mkdir(join(f.root, `folder-${String(start + offset).padStart(4, "0")}`)),
        ),
      );
    const client = await server.connect();
    expect(await finishPickerIndex(client, "folder-0000")).toMatchObject({
      entries: [{ name: "folder-0000" }],
      indexing: false,
      truncated: true,
    });
    expect(await finishPickerIndex(client, "folder-1022")).toMatchObject({
      entries: [{ name: "folder-1022" }],
    });
    // The root consumes one admission slot. These siblings must stay absent after all work drains.
    expect(await finishPickerIndex(client, "folder-1023")).toMatchObject({ entries: [] });
    expect(await finishPickerIndex(client, "folder-1099")).toMatchObject({ entries: [] });
  } finally {
    await server.close();
    await f.close();
  }
}, 30_000);

test("the depth cap excludes a fifth-level folder independently of directory count", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "one", "two", "three", "four", "fifth-level"), { recursive: true });
    const client = await server.connect();
    expect(await finishPickerIndex(client, "four")).toMatchObject({
      entries: [{ name: "four" }],
      indexing: false,
    });
    expect(await finishPickerIndex(client, "fifth-level")).toMatchObject({
      entries: [],
      indexing: false,
      truncated: true,
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("superseding one socket's pending validation leaves overlapping work on another socket alive", async () => {
  let armed = false;
  let target = "";
  let pending = 0;
  const bothEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await projectFixture({
    pickerClock: () => 1000,
    pickerFilesystem: {
      ...pickerFilesystem,
      async open(paths, path) {
        if (armed && path === target) {
          pending++;
          if (pending === 2) bothEntered.resolve();
          await release.promise;
        }
        return pickerFilesystem.open(paths, path);
      },
    },
  });
  target = join(f.root, "target-project");
  const server = await projectServer(f);
  try {
    await mkdir(target);
    const first = await server.connect();
    const other = await server.connect({ deviceId: "other-window" });
    await finishPickerIndex(first, "target-project");
    armed = true;
    const operation = {
      op: "fs.search" as const,
      query: "target-project",
      limit: 1,
      showHidden: false,
    };
    first.send(
      ProjectsRequest.parse({ type: "projects.request", requestId: "overlapping-old", operation }),
    );
    const otherReply = pickerRead(other, operation);
    void otherReply.catch(() => {});
    await bothEntered.promise;
    expect(
      await pickerRead(first, {
        op: "fs.complete",
        path: "~/absent-",
        limit: 1,
        showHidden: false,
      }),
    ).toMatchObject({ kind: "completion", candidates: [] });
    release.resolve();
    expect(
      await until(
        first,
        (message) => message.type === "projects.result" && message.requestId === "overlapping-old",
      ),
    ).toMatchObject({ result: { kind: "error", code: "search_cancelled" } });
    expect(await otherReply).toMatchObject({
      kind: "search",
      entries: [{ name: "target-project" }],
    });
  } finally {
    release.resolve();
    await server.close();
    await f.close();
  }
});
