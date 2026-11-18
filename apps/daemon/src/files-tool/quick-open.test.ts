import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { quickOpenPaths } from "./quick-open.ts";

const main = ThreadId.parse("main");

it("answers with the index's paths once it is ready", async () => {
  const paths = await quickOpenPaths(
    {
      root: () => Promise.resolve("/w"),
      ask: (root, query, limit) => Promise.resolve([`${root}:${query}:${limit}`]),
    },
    main,
    "main.rs",
    50,
  );
  expect(paths).toEqual(["/w:main.rs:50"]);
});

it("keeps an empty index answer instead of falling back", async () => {
  const paths = await quickOpenPaths(
    { root: () => Promise.resolve("/w"), ask: () => Promise.resolve([]) },
    main,
    "nothing",
    50,
  );
  expect(paths).toEqual([]);
});

it("falls back while the checkout is still being prepared", async () => {
  let asked = false;
  const paths = await quickOpenPaths(
    {
      root: () => Promise.resolve(undefined),
      ask: () => {
        asked = true;
        return Promise.resolve(["a"]);
      },
    },
    main,
    "a",
    50,
  );
  expect(paths).toBeUndefined();
  expect(asked).toBe(false);
});

it("falls back while the index is still building", async () => {
  const paths = await quickOpenPaths(
    { root: () => Promise.resolve("/w"), ask: () => Promise.resolve(undefined) },
    main,
    "a",
    50,
  );
  expect(paths).toBeUndefined();
});

it("falls back when ace-files cannot answer", async () => {
  const paths = await quickOpenPaths(
    {
      root: () => Promise.resolve("/w"),
      ask: () => Promise.reject(new Error("FILES_RESTARTING")),
    },
    main,
    "a",
    50,
  );
  expect(paths).toBeUndefined();
});
