import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { createWorkspace } from "@ace/workspace";
import { createExclusiveRename } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function barrier() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanup.push(() => f.close());
  return f;
}
const Upload = z.object({ uploadId: z.string() });
async function version(f: Awaited<ReturnType<typeof fixture>>, path: string) {
  return z
    .object({ version: z.string().nullable() })
    .parse(await f.service.request("writer", { op: "stat", path })).version;
}

for (const operation of ["move", "rename", "restore", "create", "upload.commit"] as const) {
  it(`preserves a concurrent agent destination when ${operation} reaches its filesystem commit`, async () => {
    const native = createExclusiveRename();
    const entered = barrier();
    const resume = barrier();
    let pause = false;
    const f = await setup({
      exclusiveRename: {
        async move(source, destination) {
          if (pause) {
            entered.resolve();
            await resume.promise;
          }
          await native.move(source, destination);
        },
        close: () => native.close(),
      },
    });
    await writeFile(join(f.root, "source"), "source bytes");
    const current = await version(f, "source");
    let request: unknown;
    if (operation === "restore") {
      const deleted = z.object({ trashId: z.string() }).parse(
        await f.service.request("writer", {
          op: "delete",
          path: "source",
          expected: current,
        }),
      );
      request = { op: "restore", trashId: deleted.trashId, path: "destination", expected: null };
    } else if (operation === "create") {
      request = { op: "create", path: "destination", expected: null, text: "source bytes" };
    } else if (operation === "upload.commit") {
      const upload = Upload.parse(
        await f.service.request("writer", {
          op: "upload.begin",
          path: "destination",
          expected: null,
          size: 0,
        }),
      );
      request = {
        op: operation,
        uploadId: upload.uploadId,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      };
    } else {
      request = {
        op: operation,
        path: "source",
        expected: current,
        destination: "destination",
        destinationExpected: null,
      };
    }
    pause = true;
    const pending = f.service.request("writer", request);
    const rejection = expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    try {
      await entered.promise;
      await writeFile(join(f.root, "destination"), "agent bytes", { flag: "wx" });
    } finally {
      resume.resolve();
    }
    await rejection;
    expect(await readFile(join(f.root, "destination"), "utf8")).toBe("agent bytes");
    if (operation === "move" || operation === "rename")
      expect(await readFile(join(f.root, "source"), "utf8")).toBe("source bytes");
    if (operation === "restore")
      expect(await f.service.request("writer", { op: "trash.list" })).toMatchObject({
        entries: [expect.objectContaining({ path: "source" })],
      });
  });
}
it("preserves a directory created concurrently with a folder move", async () => {
  const native = createExclusiveRename();
  const entered = barrier();
  const resume = barrier();
  const f = await setup({
    exclusiveRename: {
      async move(source, destination) {
        entered.resolve();
        await resume.promise;
        await native.move(source, destination);
      },
      close: () => native.close(),
    },
  });
  await mkdir(join(f.root, "source"));
  await writeFile(join(f.root, "source", "file"), "original");
  const pending = f.service.request("writer", {
    op: "move",
    path: "source",
    expected: await version(f, "source"),
    destination: "destination",
    destinationExpected: null,
  });
  const rejection = expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
  try {
    await entered.promise;
    await mkdir(join(f.root, "destination"));
  } finally {
    resume.resolve();
  }
  await rejection;
  expect(await readdir(join(f.root, "destination"))).toEqual([]);
  expect(await readFile(join(f.root, "source", "file"), "utf8")).toBe("original");
});

it("rejects direct and parent symlink aliases to private upload bytes through public readers", async () => {
  const f = await setup();
  const upload = Upload.parse(
    await f.service.request("writer", {
      op: "upload.begin",
      path: "destination",
      expected: null,
      size: 6,
    }),
  );
  await f.service.append("writer", upload.uploadId, 0, Buffer.from("secret"));
  const temp = `.ace-upload-${upload.uploadId}`;
  await symlink(temp, join(f.root, "alias"));
  await symlink(".", join(f.root, "parent-alias"));
  for (const path of ["alias", `parent-alias/${temp}`]) {
    await expect(f.service.download("writer", { op: "download", path })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  }
  const workspace = await createWorkspace(f.root);
  await expect(workspace.read({ path: "alias" })).rejects.toMatchObject({ code: "INVALID_PATH" });
  const client = await f.connect();
  expect(await client.request({ op: "download", path: "alias", offset: 0 })).toMatchObject({
    code: "INVALID_PATH",
  });
});

it("reconciles relocated upload temps after restart before refunding their reserved quota", async () => {
  let now = 0;
  const f = await setup({ now: () => now, retentionMs: 10, maxReservedBytes: 4 });
  await mkdir(join(f.root, "parent"));
  const upload = Upload.parse(
    await f.service.request("writer", {
      op: "upload.begin",
      path: "parent/result",
      expected: null,
      size: 4,
    }),
  );
  await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
  await rename(join(f.root, "parent"), join(f.root, "relocated"));
  await f.restart();
  now = 11;
  await f.service.sweep();
  expect(await readdir(join(f.root, "relocated"))).toEqual([]);
  expect(
    await f.service.request("writer", {
      op: "upload.begin",
      path: "next",
      expected: null,
      size: 4,
    }),
  ).toMatchObject({ offset: 0 });
});
it("retains cleanup debt for an outside upload and never deletes a replacement inode", async () => {
  let now = 0;
  const f = await setup({ now: () => now, retentionMs: 10, maxReservedBytes: 4 });
  await mkdir(join(f.root, "parent"));
  const upload = Upload.parse(
    await f.service.request("writer", {
      op: "upload.begin",
      path: "parent/result",
      expected: null,
      size: 4,
    }),
  );
  await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
  const temp = `.ace-upload-${upload.uploadId}`;
  await rename(join(f.root, "parent"), join(f.home, "outside"));
  await mkdir(join(f.root, "parent"));
  await writeFile(join(f.root, "parent", temp), "agent replacement");
  now = 11;
  await f.service.sweep();
  expect(await readFile(join(f.root, "parent", temp), "utf8")).toBe("agent replacement");
  expect(await readFile(join(f.home, "outside", temp), "utf8")).toBe("data");
  await expect(
    f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 4 }),
  ).rejects.toMatchObject({ code: "QUOTA" });
  await rm(join(f.root, "parent"), { recursive: true });
  await rename(join(f.home, "outside"), join(f.root, "returned"));
  await f.service.sweep();
  expect(await readdir(join(f.root, "returned"))).toEqual([]);
  expect(
    await f.service.request("writer", {
      op: "upload.begin",
      path: "next",
      expected: null,
      size: 4,
    }),
  ).toMatchObject({ offset: 0 });
});
it("discovers and restores trash after the deleting client loses its response", async () => {
  const f = await setup();
  await writeFile(join(f.root, "lost"), "recoverable");
  const client = await f.connect();
  const before = await version(f, "lost");
  const changed = barrier();
  const unsubscribe = f.service.subscribe((change) => {
    if (change.op === "delete") changed.resolve();
  });
  client.send({
    type: "files.request",
    requestId: "lost-result",
    operation: { op: "delete", path: "lost", expected: before },
  });
  await changed.promise;
  unsubscribe();
  await client.close();
  await f.restart();
  const reconnected = await f.connect(true);
  const listing = z
    .object({
      value: z.object({
        entries: z.array(z.object({ id: z.string(), path: z.string() })),
        nextCursor: z.string().nullable(),
      }),
    })
    .parse(await reconnected.request({ op: "trash.list", limit: 1 }));
  expect(listing.value.entries).toHaveLength(1);
  expect(listing.value.entries[0]?.path).toBe("lost");
  const entry = listing.value.entries.at(0);
  if (!entry) throw new Error("No recovery entry");
  const writer = await f.connect();
  expect(
    await writer.request({ op: "restore", path: "lost", expected: null, trashId: entry.id }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "lost"), "utf8")).toBe("recoverable");
});

it("pages recoverable trash without duplicates and excludes expired entries for read-only clients", async () => {
  let now = 0;
  const f = await setup({ now: () => now, retentionMs: 10 });
  for (const path of ["a", "b", "c"]) {
    await writeFile(join(f.root, path), path);
    await f.service.request("writer", { op: "delete", path, expected: await version(f, path) });
  }
  const reader = await f.connect(true);
  const Page = z.object({
    value: z.object({
      entries: z.array(z.object({ id: z.string(), path: z.string() })),
      nextCursor: z.string().nullable(),
    }),
  });
  const first = Page.parse(await reader.request({ op: "trash.list", limit: 2 })).value;
  expect(first.entries).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  if (first.nextCursor === null) throw new Error("Missing trash cursor");
  const second = Page.parse(
    await reader.request({ op: "trash.list", limit: 2, after: first.nextCursor }),
  ).value;
  expect(second.entries).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect([...first.entries, ...second.entries].map((entry) => entry.path).toSorted()).toEqual([
    "a",
    "b",
    "c",
  ]);
  now = 11;
  expect(Page.parse(await reader.request({ op: "trash.list", limit: 2 })).value.entries).toEqual(
    [],
  );
});
