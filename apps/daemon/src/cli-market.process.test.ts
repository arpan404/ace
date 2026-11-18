import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { invoke } from "./cli-test-support.ts";

/*
 * The old spellings `ace marketplace check` and `ace market keygen` through the real CLI
 * (ADR 0168 §6, §7; ADR 0178 §8): they keep working during the deprecation window.
 */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-cli-market-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function skill(name: string, files: Record<string, string>) {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  for (const [path, text] of Object.entries(files)) await writeFile(join(folder, path), text);
  return folder;
}

test("check passes a skill folder that meets the market's rules and refuses one that doesn't, line by line", async () => {
  const good = await skill("triage-mail", {
    "SKILL.md": "---\nname: triage-mail\ndescription: Sorts mail.\n---\n# Triage\n",
  });
  const passed = await invoke(root, [
    "marketplace",
    "check",
    good,
    "--type",
    "spade-skill",
    "--json",
  ]);
  expect(passed.code).toBe(0);
  expect(JSON.parse(passed.stdout)).toMatchObject({
    name: "triage-mail",
    problems: [],
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  const bad = await skill("leaky", {
    "SKILL.md":
      "---\nname: leaky\ndescription: Leaks.\n---\nuse ghp_REDACTEDREDACTEDREDACTEDREDACTEDREDACTED\n",
  });
  const refused = await invoke(root, ["marketplace", "check", bad, "--type", "spade-skill"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/SKILL\.md:5: .*GitHub token/);
});

test("keygen writes a private key only its owner can read, and never overwrites one", async () => {
  const path = join(root, "market.key");
  const made = await invoke(root, ["market", "keygen", path, "--id", "market-1", "--json"]);
  expect(made.code).toBe(0);
  expect(JSON.parse(made.stdout)).toMatchObject({
    publicKey: { id: "market-1", publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
  });
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await invoke(root, ["market", "keygen", path])).code).not.toBe(0);
});
