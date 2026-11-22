import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  expect(ownerMode(released, Date.now).orgHost()).toBe(true);
  // A person's owner record beside the seal changes nothing.
  const claimed = home();
  seal(claimed);
  writeFileSync(join(claimed, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  expect(ownerMode(claimed, Date.now).orgHost()).toBe(true);
  const personal = home();
  writeFileSync(join(personal, "ace-owner.json"), JSON.stringify({ account: "user_p" }));
  expect(ownerMode(personal, Date.now).orgHost()).toBe(false);
});
