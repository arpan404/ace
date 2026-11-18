import { expect, it } from "vitest";
import { FilesRoots } from "./roots.ts";

function book(idleMs = 10 * 60_000) {
  let next = 0;
  let now = 0;
  const opened: string[] = [];
  const closed: number[] = [];
  const roots = new FilesRoots(
    {
      canonicalize: (path) => Promise.resolve(`/real${path.replace(/\/+$/, "")}`),
      open: (path) => {
        opened.push(path);
        return Promise.resolve(++next);
      },
      close: (root) => {
        closed.push(root);
        return Promise.resolve();
      },
      now: () => now,
    },
    idleMs,
  );
  return {
    roots,
    opened,
    closed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("opens one checkout once and shares it", async () => {
  const { roots, opened } = book();
  const first = await roots.use("/w", (root) => Promise.resolve(root));
  const second = await roots.use("/w", (root) => Promise.resolve(root));
  expect(second).toBe(first);
  expect(opened).toEqual(["/real/w"]);
});

it("treats two spellings of one folder as one root", async () => {
  const { roots, opened } = book();
  const first = await roots.use("/w", (root) => Promise.resolve(root));
  const second = await roots.use("/w/", (root) => Promise.resolve(root));
  expect(second).toBe(first);
  expect(opened).toHaveLength(1);
});

it("closes a root nobody used for ten minutes", async () => {
  const { roots, advance, closed, opened } = book();
  const root = await roots.use("/w", (value) => Promise.resolve(value));
  advance(9 * 60_000);
  expect(await roots.sweep()).toEqual([]);
  advance(60_000);
  expect(await roots.sweep()).toEqual(["/real/w"]);
  expect(closed).toEqual([root]);
  await roots.use("/w", (value) => Promise.resolve(value));
  expect(opened).toEqual(["/real/w", "/real/w"]);
});

it("keeps a held root open past the idle window", async () => {
  const { roots, advance, closed } = book();
  const hold = await roots.hold("/w");
  advance(30 * 60_000);
  expect(await roots.sweep()).toEqual([]);
  expect(closed).toEqual([]);
  hold.release();
  advance(10 * 60_000);
  expect(await roots.sweep()).toEqual(["/real/w"]);
  expect(closed).toEqual([hold.root]);
});

it("opens a root ace-files refused again next time", async () => {
  let attempts = 0;
  let now = 0;
  const roots = new FilesRoots({
    canonicalize: (path) => Promise.resolve(path),
    open: () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("the folder vanished")) : Promise.resolve(7);
    },
    close: () => Promise.resolve(),
    now: () => now,
  });
  await expect(roots.use("/w", (root) => Promise.resolve(root))).rejects.toThrow(
    "the folder vanished",
  );
  expect(await roots.use("/w", (root) => Promise.resolve(root))).toBe(7);
  expect(attempts).toBe(2);
});

it("closing the book closes every open root", async () => {
  const { roots, closed } = book();
  await roots.use("/a", (root) => Promise.resolve(root));
  await roots.use("/b", (root) => Promise.resolve(root));
  await roots.close();
  expect(closed.toSorted()).toEqual([1, 2]);
});
