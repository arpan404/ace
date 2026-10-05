import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { expect, test } from "vitest";
import { pickerFilesystem } from "./project-picker-filesystem.ts";
import {
  projectFixture,
  projectServer,
  pickerRead,
  finishPickerIndex,
} from "./projects-test-support.ts";

for (const operation of ["search", "completion"] as const) {
  test(`a disappearing enumerated child leaves healthy siblings available to ${operation}`, async () => {
    let vanished = false;
    const f = await projectFixture({
      pickerClock: () => 1000,
      pickerFilesystem: {
        ...pickerFilesystem,
        metadata(directory, name) {
          if (!vanished && name === "a-disappearing") {
            vanished = true;
            rmSync(join(directory.path, name), { recursive: true });
          }
          return pickerFilesystem.metadata(directory, name);
        },
      },
    });
    const server = await projectServer(f);
    try {
      await mkdir(join(f.root, "a-disappearing"));
      await mkdir(join(f.root, "z-healthy"));
      const client = await server.connect();
      const result =
        operation === "search"
          ? await finishPickerIndex(client, "healthy")
          : await pickerRead(client, {
              op: "fs.complete",
              path: "~/",
              limit: 100,
              showHidden: false,
            });
      expect(result).toMatchObject(
        operation === "search"
          ? { entries: [{ name: "z-healthy" }], indexing: false }
          : { candidates: [{ name: "z-healthy" }], commonPrefix: "~/z-healthy/" },
      );
      expect(await finishPickerIndex(client, "disappearing")).toMatchObject({ entries: [] });
    } finally {
      await server.close();
      await f.close();
    }
  });
}

test("a transient directory enumeration failure is retried by the next socket search", async () => {
  let failed = false;
  const f = await projectFixture({
    pickerClock: () => 1000,
    pickerFilesystem: {
      ...pickerFilesystem,
      names(directory) {
        if (!failed) {
          failed = true;
          throw Object.assign(new Error("Temporary filesystem failure"), { code: "EAGAIN" });
        }
        return pickerFilesystem.names(directory);
      },
    },
  });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "healthy-project"));
    const client = await server.connect();
    expect(
      await pickerRead(client, { op: "fs.search", query: "healthy", limit: 10, showHidden: false }),
    ).toMatchObject({ indexing: true });
    expect(await finishPickerIndex(client, "healthy")).toMatchObject({
      entries: [{ name: "healthy-project" }],
      indexing: false,
      truncated: false,
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test.skipIf(sep !== "/")(
  "literal POSIX backslashes in roots and descendants get a socket response",
  async () => {
    let root = "";
    const f = await projectFixture({ pickerClock: () => 1000, roots: async () => [root] });
    root = join(f.root, "a\\b");
    await mkdir(root);
    const server = await projectServer(f);
    try {
      await mkdir(join(root, "c\\d"));
      await mkdir(join(root, "literal\\Library"));
      const client = await server.connect();
      expect(await finishPickerIndex(client, "")).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ name: "a\\b", path: root }),
          expect.objectContaining({ name: "c\\d", path: join(root, "c\\d") }),
          expect.objectContaining({ name: "literal\\Library" }),
        ]),
      });
      expect(
        await pickerRead(client, {
          op: "fs.complete",
          path: `${root}/c`,
          limit: 10,
          showHidden: false,
        }),
      ).toMatchObject({
        candidates: [{ name: "c\\d", completion: `${root}/c\\d/` }],
      });
      expect(
        await pickerRead(client, { op: "fs.browse", path: root, limit: 10, showHidden: false }),
      ).toMatchObject({
        entries: [{ name: "c\\d" }, { name: "literal\\Library" }],
      });
    } finally {
      await server.close();
      await f.close();
    }
  },
);

test("all substring names rank above fuzzy names even with long leading text", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    const substring = "x".repeat(220) + "ace";
    await mkdir(join(f.root, substring));
    await mkdir(join(f.root, "a-c-e"));
    const client = await server.connect();
    const result = await finishPickerIndex(client, "ace");
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain(substring);
    expect(names).toContain("a-c-e");
    expect(names.indexOf(substring)).toBeLessThan(names.indexOf("a-c-e"));
  } finally {
    await server.close();
    await f.close();
  }
});

test("completion rejects final traversal and NUL segments before reading the parent", async () => {
  const f = await projectFixture();
  const server = await projectServer(f);
  try {
    const client = await server.connect();
    for (const path of [`${f.root}/..`, `${f.root}/bad\0prefix`, "~/..", "~/bad\0prefix"])
      expect(
        await pickerRead(client, { op: "fs.complete", path, limit: 10, showHidden: false }),
      ).toMatchObject({ kind: "error", code: "invalid_path" });
  } finally {
    await server.close();
    await f.close();
  }
});

test("resuming a wide directory search uses its retained enumeration to reach later siblings", async () => {
  let parent = "";
  let enumerated = false;
  const f = await projectFixture({
    pickerClock: () => 1000,
    pickerFilesystem: {
      ...pickerFilesystem,
      names(directory) {
        // The initial successful snapshot stays usable even if a subsequent readdir would fail.
        if (directory.path === parent) {
          if (enumerated)
            throw Object.assign(new Error("Enumeration became unavailable"), { code: "EACCES" });
          enumerated = true;
        }
        return pickerFilesystem.names(directory);
      },
    },
  });
  parent = f.root;
  const server = await projectServer(f);
  try {
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(join(parent, `a-file-${String(index).padStart(4, "0")}`), ""),
      ),
    );
    await mkdir(join(parent, "z-project"));
    const client = await server.connect();
    expect(await finishPickerIndex(client, "z-project")).toMatchObject({
      entries: [{ name: "z-project" }],
      indexing: false,
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("stale exact hits are evicted without reporting a truncated full search", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "needle-folder"));
    await mkdir(join(f.root, "needle-folder-old"));
    const client = await server.connect();
    await finishPickerIndex(client, "needle-folder");
    await rm(join(f.root, "needle-folder"), { recursive: true });
    expect(
      await pickerRead(client, {
        op: "fs.search",
        query: "needle-folder",
        limit: 1,
        showHidden: false,
      }),
    ).toMatchObject({ entries: [{ name: "needle-folder-old" }], truncated: false });
    expect(
      await pickerRead(client, {
        op: "fs.search",
        query: "needle-folder",
        limit: 1,
        showHidden: false,
      }),
    ).toMatchObject({ entries: [{ name: "needle-folder-old" }], truncated: false });
  } finally {
    await server.close();
    await f.close();
  }
});
