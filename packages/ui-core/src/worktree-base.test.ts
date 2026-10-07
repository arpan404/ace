import type { BranchRef } from "@ace/protocol";
import { expect, test } from "vitest";
import { checkoutOf } from "./checkout.ts";
import { baseOptions, baseRecordText, defaultWorktreeBase } from "./worktree-base.ts";

const origin = (name: string): BranchRef => ({ name, remote: "origin" });

test("a new worktree starts from the remote's copy of the default branch when the local one is behind", () => {
  const refs = [
    { name: "main", upstream: "origin/main", behind: 3 },
    { name: "develop" },
    origin("main"),
    origin("develop"),
  ];
  expect(defaultWorktreeBase(refs, "main")).toEqual({ ref: "main", remote: "origin" });
});

test("local commits the remote doesn't have keep the default on the local branch", () => {
  const refs = [{ name: "main", upstream: "origin/main", ahead: 2, behind: 1 }, origin("main")];
  expect(defaultWorktreeBase(refs, "main")).toEqual({ ref: "main" });
});

test("a default branch only the remote has is offered from the remote, and a local-only one locally", () => {
  expect(defaultWorktreeBase([origin("trunk"), { name: "spike" }], "trunk")).toEqual({
    ref: "trunk",
    remote: "origin",
  });
  expect(defaultWorktreeBase([{ name: "main" }, { name: "spike" }], undefined)).toEqual({
    ref: "main",
  });
});

test("the picker lists remote branches first, the default on top, and narrows by any part of the name", () => {
  const refs = [
    { name: "main", upstream: "origin/main", behind: 2 },
    { name: "develop" },
    origin("release/0.9"),
    origin("main"),
    origin("fix/login-timeout"),
  ];
  const all = baseOptions(refs, "main");
  expect(all.remote.map((option) => [option.label, option.note])).toEqual([
    ["origin/main", "default"],
    ["origin/fix/login-timeout", undefined],
    ["origin/release/0.9", undefined],
  ]);
  expect(all.local.map((option) => [option.label, option.note])).toEqual([
    ["main", "default · 2 behind origin"],
    ["develop", undefined],
  ]);
  const found = baseOptions(refs, "main", "LOGIN");
  expect([...found.remote, ...found.local].map((option) => option.base)).toEqual([
    { ref: "fix/login-timeout", remote: "origin" },
  ]);
});

test("a worktree made while the remote was unreachable says it started from the last fetched copy", () => {
  const head = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
  expect(baseRecordText({ ref: "main", remote: "origin", head, fetch: "fetched" })).toEqual({
    text: "origin/main at 1a2b3c4",
  });
  expect(baseRecordText({ ref: "main", remote: "origin", head, fetch: "unreachable" }).note).toBe(
    "origin couldn't be reached, so it started from the last fetched copy.",
  );
});

test("a pull request from a worktree started on origin/main merges into main", () => {
  const checkout = checkoutOf({
    mode: "worktree",
    branch: "ace/1234",
    baseBranch: "origin/main",
    base: { ref: "main", remote: "origin", head: "a".repeat(40), fetch: "fetched" },
  });
  expect(checkout?.baseBranch).toBe("main");
});
