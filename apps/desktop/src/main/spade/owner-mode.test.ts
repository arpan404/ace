import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ownerMode } from "./owner-mode.ts";

// ADR 0209 amendment 1: a released org host keeps its seal, so the app's direct Spade path stays
// off there, whatever the owner file says or whether it is there at all.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-mode-"));
  homes.push(dir);
  return dir;
};
const seal = (dir: string) =>
  writeFileSync(
    join(dir, "ace-org-seal.json"),
    JSON.stringify({ kind: "org-seal", org: "org_acme" }),
  );

test("a sealed home is an organization's, released or reset, and a person's home isn't", () => {
  const released = home();
  seal(released);
  expect(ownerMode(released).orgHost()).toBe(true);
  // A person's owner record beside the seal changes nothing.
  const claimed = home();
  seal(claimed);
  writeFileSync(join(claimed, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  expect(ownerMode(claimed).orgHost()).toBe(true);
  const personal = home();
  writeFileSync(join(personal, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  expect(ownerMode(personal).orgHost()).toBe(false);
});

test("a seal written after the last read counts at once, with no cached answer to wait out", () => {
  // ADR 0209 §3: every send and reply asks afresh.
  const dir = home();
  writeFileSync(join(dir, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  const mode = ownerMode(dir);
  expect(mode.orgHost()).toBe(false);
  seal(dir);
  expect(mode.orgHost()).toBe(true);
});

test("a seal that is there but can't be read or parsed keeps the home an organization's", () => {
  // Only a missing seal makes a person's home: anything else fails closed.
  const garbled = home();
  writeFileSync(join(garbled, "ace-org-seal.json"), "{not json");
  writeFileSync(join(garbled, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  expect(ownerMode(garbled).orgHost()).toBe(true);
  const unreadable = home();
  mkdirSync(join(unreadable, "ace-org-seal.json"));
  expect(ownerMode(unreadable).orgHost()).toBe(true);
});
