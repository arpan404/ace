import { expect, test } from "vitest";
import {
  ancestorFolders,
  buildFileTree,
  fileLanguage,
  fuzzyPositions,
  imageType,
  isCheckoutPath,
  isText,
  rememberRecent,
  checkoutTreeRows,
} from "./checkout-files.ts";

test("paths outside the checkout are never accepted", () => {
  expect(isCheckoutPath("src/app.ts")).toBe(true);
  expect(isCheckoutPath("src/")).toBe(true);
  for (const bad of ["", "/etc/passwd", "../secret", "a/../../b", "a\\b", "a//b", "./a"])
    expect(isCheckoutPath(bad)).toBe(false);
});

test("the tree lists folders before files, by name, with every parent folder", () => {
  const tree = buildFileTree([
    "src/lib/fetch.ts",
    "README.md",
    "src/app.tsx",
    "docs/",
    "src/index.ts",
    "../escape.ts",
  ]);
  expect(tree.map((node) => node.name)).toEqual(["docs", "src", "README.md"]);
  const src = tree[1];
  expect(src?.children.map((node) => node.path)).toEqual([
    "src/lib/",
    "src/app.tsx",
    "src/index.ts",
  ]);
  const rows = checkoutTreeRows(tree, (folder) => folder === "src/");
  expect(rows.map((row) => `${row.depth}:${row.node.name}`)).toEqual([
    "0:docs",
    "0:src",
    "1:lib",
    "1:app.tsx",
    "1:index.ts",
    "0:README.md",
  ]);
  expect(ancestorFolders("src/lib/fetch.ts")).toEqual(["src/", "src/lib/"]);
});

test("bytes with a NUL or broken UTF-8 are binary; a code point cut at a chunk edge is not", () => {
  const encoded = new TextEncoder().encode("héllo");
  expect(isText(encoded)).toBe(true);
  expect(isText(new Uint8Array([104, 0, 105]))).toBe(false);
  expect(isText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  expect(isText(encoded.subarray(0, 2), true)).toBe(true);
});

test("a file's language and image type come from its extension", () => {
  expect(fileLanguage("apps/web/main.tsx")).toBe("tsx");
  expect(fileLanguage("Makefile")).toBeUndefined();
  expect(imageType("assets/logo.SVG")).toBe("image/svg+xml");
  expect(imageType("src/app.ts")).toBeUndefined();
});

test("fuzzy highlights prefer the file name over its folders", () => {
  expect(fuzzyPositions("cfg", "config/cfg.ts")).toEqual([7, 8, 9]);
  expect(fuzzyPositions("srcapp", "src/app.tsx")).toEqual([0, 1, 2, 4, 5, 6]);
  expect(fuzzyPositions("zz", "src/app.tsx")).toBeUndefined();
});

test("recent files keep the newest first, once each, bounded", () => {
  let recent: string[] = [];
  for (const path of ["a", "b", "c", "a"]) recent = rememberRecent(recent, path, 3);
  expect(recent).toEqual(["a", "c", "b"]);
});
