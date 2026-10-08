import { open, readFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { atomicWrite, fileIO, readBounded, MAX_DOCUMENT_BYTES } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function gate() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      resolve?.();
    },
  };
}

test.each(["file", "directory"] as const)(
  "atomic commits wait for %s durability before reporting success",
  async (kind) => {
    const f = await fixture();
    cleanups.push(() => f.close());
    await f.write(f.globalPath, { "threads.settleOnClose": false });
    const entered = gate();
    const release = gate();
    const opening: typeof open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === (kind === "file" ? "wx" : "r")) {
        const physicalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          entered.resolve();
          await release.promise;
          await physicalSync();
        };
      }
      return handle;
    };
    const writing = atomicWrite(
      f.globalPath,
      '{"version":2,"settings":{"threads.settleOnClose":true}}',
      undefined,
      opening,
    );
    try {
      const first = await Promise.race([
        entered.promise.then(() => "awaiting durability"),
        writing.then(() => "committed"),
      ]);
      expect(first).toBe("awaiting durability");
      expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
        settings: { "threads.settleOnClose": kind === "directory" },
      });
    } finally {
      release.resolve();
      await writing;
    }
    expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
      settings: { "threads.settleOnClose": true },
    });
  },
);

test("shutdown stays pending while an accepted real file write awaits commit", async () => {
  const entered = gate();
  const release = gate();
  const f = await fixture({
    io: {
      ...fileIO,
      watch: async () => () => {},
      write: (path, text) =>
        atomicWrite(path, text, async () => {
          entered.resolve();
          await release.promise;
        }),
    },
  });
  cleanups.push(() => f.close());
  const writing = f.service.set("threads.settleOnClose", true, { kind: "global" });
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  try {
    // Other public operations finish rejecting while the accepted write is blocked.
    for (let index = 0; index < 8; index++)
      await expect(f.service.get("threads.settleOnClose")).rejects.toThrow("closed");
    expect(closed).toBe(false);
  } finally {
    release.resolve();
    await writing;
    await closing;
  }
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.settleOnClose": true },
  });
});

const boundedAllocation = (bytes: number) => {
  if (bytes > MAX_DOCUMENT_BYTES + 1)
    throw new RangeError("Allocation exceeded available memory capacity");
  return Buffer.alloc(bytes);
};

test("oversized sparse documents fail before exhausting a bounded allocation boundary", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const file = await open(f.globalPath, "w");
  try {
    await file.truncate(MAX_DOCUMENT_BYTES * 4);
  } finally {
    await file.close();
  }

  await expect(readBounded(f.globalPath, boundedAllocation)).rejects.toMatchObject({
    code: "size",
    message: "Settings document exceeds 1 MiB",
  });
});
