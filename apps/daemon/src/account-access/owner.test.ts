import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { machineOwner } from "./owner.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function owned(account?: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-owner-"));
  roots.push(root);
  const owner = machineOwner(root);
  await owner.load();
  if (account) expect(await owner.claim(account, owner.generation())).toBe(true);
  return { owner, root };
}

test("the first proof's own account becomes the owner, and is kept across a restart", async () => {
  const { owner, root } = await owned();
  expect(await owner.claim("user_p", owner.generation())).toBe(true);
  expect(await owner.claim("user_q", owner.generation())).toBe(false);
  const again = machineOwner(root);
  await again.load();
  expect(again.current()).toBe("user_p");
});

test("an account proof begun before a release never reclaims the machine after it", async () => {
  const { owner } = await owned("user_p");
  // The proof read the generation as it began, then went off to verify its grant.
  const seen = owner.generation();
  await owner.release(() => {});
  expect(owner.current()).toBeUndefined();
  expect(await owner.claim("user_p", seen)).toBe(false);
  expect(owner.current()).toBeUndefined();
  // A proof begun after it does.
  expect(await owner.claim("user_p", owner.generation())).toBe(true);
});

test("a claim that arrives while a release is under way waits for it, then fails", async () => {
  const { owner } = await owned("user_p");
  const seen = owner.generation();
  const releasing = owner.release(() => {});
  const claiming = owner.claim("user_p", seen);
  await releasing;
  expect(await claiming).toBe(false);
  expect(owner.current()).toBeUndefined();
});

test("standing proven before a release, or while it runs, stops counting the moment it starts", async () => {
  const { owner } = await owned("user_p");
  const before = owner.generation();
  expect(owner.holds(before)).toBe(true);
  let during: number | undefined;
  const releasing = owner.release(() => {
    // A paired device's proof that reads the generation now, before the file is gone.
    during = owner.generation();
  });
  // Already over, before the release has finished.
  await Promise.resolve();
  expect(owner.holds(before)).toBe(false);
  await releasing;
  expect(during).toBeDefined();
  expect(owner.holds(before)).toBe(false);
  expect(owner.holds(during ?? before)).toBe(false);
  expect(owner.holds(owner.generation())).toBe(true);
});

test("given to an organization, the machine answers to it across a restart, and no person's proof claims it, released or not", async () => {
  const { owner, root } = await owned("user_p");
  const before = owner.generation();
  let dropped = false;
  // Only the owner, proven under the current generation, gives it.
  expect(await owner.enroll("user_q", "org_team", before, () => {})).toBe(false);
  expect(await owner.enroll("user_p", "org_team", before, () => (dropped = true))).toBe(true);
  expect(dropped).toBe(true);
  expect(owner.holds(before)).toBe(false);
  const again = machineOwner(root);
  await again.load();
  expect(again.org()).toBe("org_team");
  expect(again.current()).toBeUndefined();
  expect(await again.claim("user_p", again.generation())).toBe(false);
  await again.release(() => {});
  expect(again.org()).toBeUndefined();
  // Released, its data stays sealed (ADR 0209 amendment 1).
  expect(await again.claim("user_q", again.generation())).toBe(false);
});

test("releasing an organization's host seals its data: no person claims that home afterwards", async () => {
  // ADR 0209 amendment 1: the org's threads stay on disk, so personal mode never opens them.
  const { owner, root } = await owned("user_p");
  expect(await owner.enroll("user_p", "org_acme", owner.generation(), () => {})).toBe(true);
  await owner.release(() => {});
  expect(owner.org()).toBeUndefined();
  expect(owner.sealed()).toBe("org_acme");
  expect(await owner.claim("user_p", owner.generation())).toBe(false);
  expect(await owner.claim("user_q", owner.generation())).toBe(false);
  // A restart, or the local reset that removes ace-owner.json, keeps it sealed.
  await rm(join(root, "ace-owner.json"), { force: true });
  const again = machineOwner(root);
  await again.load();
  expect(again.sealed()).toBe("org_acme");
  expect(await again.claim("user_p", again.generation())).toBe(false);
});

test("a home enrolled before seals existed is sealed the first time it loads", async () => {
  const { root } = await owned();
  await writeFile(join(root, "ace-owner.json"), JSON.stringify({ kind: "org", org: "org_acme" }));
  const owner = machineOwner(root);
  await owner.load();
  await owner.release(() => {});
  expect(owner.sealed()).toBe("org_acme");
  expect(await owner.claim("user_p", owner.generation())).toBe(false);
});

test("a person's machine is never sealed", async () => {
  const { owner } = await owned("user_p");
  await owner.release(() => {});
  expect(owner.sealed()).toBeUndefined();
  expect(await owner.claim("user_q", owner.generation())).toBe(true);
});

test("an enrollment cut off after its seal leaves a sealed home: its old owner neither proves nor re-enrolls", async () => {
  // The seal was written, then the machine stopped before the owner record was replaced.
  const { root } = await owned("user_p");
  const sealed = JSON.stringify({ kind: "org-seal", org: "org_acme" });
  await writeFile(join(root, "ace-org-seal.json"), sealed);
  const owner = machineOwner(root);
  await owner.load();
  expect(owner.sealed()).toBe("org_acme");
  expect(owner.current()).toBeUndefined();
  expect(await owner.claim("user_p", owner.generation())).toBe(false);
  expect(await owner.enroll("user_p", "org_other", owner.generation(), () => {})).toBe(false);
  expect(await readFile(join(root, "ace-org-seal.json"), "utf8")).toBe(sealed);
});

test("an owner record naming another organization than the seal never rewrites the seal", async () => {
  // A mismatch fails closed: the seal stands, and the record answers for no organization.
  const { root } = await owned();
  const sealed = JSON.stringify({ kind: "org-seal", org: "org_first" });
  await writeFile(join(root, "ace-org-seal.json"), sealed);
  await writeFile(join(root, "ace-owner.json"), JSON.stringify({ kind: "org", org: "org_other" }));
  const owner = machineOwner(root);
  await owner.load();
  expect(await readFile(join(root, "ace-org-seal.json"), "utf8")).toBe(sealed);
  expect(owner.sealed()).toBe("org_first");
  expect(owner.org()).toBeUndefined();
  expect(await owner.claim("user_p", owner.generation())).toBe(false);
});
