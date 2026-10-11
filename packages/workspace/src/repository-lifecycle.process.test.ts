import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { exec, fixture } from "./test-support.ts";

test("reused listings and searches apply Git rules after init and stop applying them after removal", async () => {
  const h = await fixture({ ripgrep: null });
  await h.file("ignored.txt", "needle");
  expect((await h.service.list({ dir: "" })).entries.map((entry) => entry.path)).toEqual([
    "ignored.txt",
  ]);
  expect(
    (await h.service.search({ query: "needle", limit: 10 })).matches.map((match) => match.path),
  ).toEqual(["ignored.txt"]);
  await exec("git", ["init", "-q", h.root]);
  await h.file(".gitignore", "ignored.txt\n");
  expect((await h.service.list({ dir: "" })).entries.map((entry) => entry.path)).toEqual([
    ".gitignore",
  ]);
  expect((await h.service.search({ query: "needle", limit: 10 })).matches).toEqual([]);
  await rm(join(h.root, ".git"), { recursive: true });
  expect((await h.service.list({ dir: "" })).entries.map((entry) => entry.path)).toEqual([
    ".gitignore",
    "ignored.txt",
  ]);
  expect(
    (await h.service.search({ query: "needle", limit: 10 })).matches.map((match) => match.path),
  ).toEqual(["ignored.txt"]);
});
