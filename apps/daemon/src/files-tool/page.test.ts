import { expect, it } from "vitest";
import { folderEntry, folderPage } from "./page.ts";

const base = {
  path: "src/main.ts",
  name: "main.ts",
  size: 120,
  mtimeMs: 1_700_000_000_000,
  ignored: false,
};

it("gives a file its kind, size and ignore state", () => {
  expect(folderEntry({ ...base, kind: { type: "file" } })).toEqual({
    path: "src/main.ts",
    name: "main.ts",
    kind: "file",
    size: 120,
    mtimeMs: 1_700_000_000_000,
    ignored: false,
  });
});

it("names what a symlink points at", () => {
  expect(
    folderEntry({ ...base, kind: { type: "symlink", target: { type: "directory" } } }),
  ).toMatchObject({ kind: "symlink", target: "directory" });
});

it("names the final kind of a link to a link", () => {
  expect(
    folderEntry({
      ...base,
      kind: { type: "symlink", target: { type: "symlink", target: { type: "file" } } },
    }),
  ).toMatchObject({ kind: "symlink", target: "file" });
});

it("leaves out a target that leaves the checkout", () => {
  const entry = folderEntry({ ...base, kind: { type: "symlink" } });
  expect(entry).toMatchObject({ kind: "symlink" });
  expect("target" in entry).toBe(false);
});

it("says the last page has no next cursor", () => {
  const page = folderPage({ entries: [], total: 0 });
  expect(page).toEqual({ entries: [], nextCursor: null, total: 0 });
  expect(folderPage({ entries: [], total: 12, nextCursor: "cursor-2" }).nextCursor).toBe(
    "cursor-2",
  );
});
