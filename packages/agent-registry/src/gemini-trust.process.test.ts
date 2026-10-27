import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { geminiWorkspaceTrust, readGeminiTrustFacts } from "./index.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-gemini-trust-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".gemini"));
  const source = join(home, "repo");
  const cwd = join(home, "worktree");
  await mkdir(source);
  await mkdir(cwd);
  const rules = join(home, ".gemini", "trustedFolders.json");
  const env = { GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system.json") };
  const read = async (sourcePath: string | undefined = source) =>
    geminiWorkspaceTrust(
      await readGeminiTrustFacts({
        env,
        userHome: "/unused",
        platform: process.platform,
        cwd,
        source: sourcePath,
      }),
    );
  return { home, source, cwd, rules, env, read };
}

test("only a worktree of a trusted checkout inherits trust, and a refusal on the worktree wins", async () => {
  const f = await fixture();
  expect(await f.read()).toEqual({ state: "untrusted", denied: false });
  await writeFile(f.rules, JSON.stringify({ [f.source]: "TRUST_FOLDER" }));
  expect(await f.read()).toEqual({ state: "inherited", from: f.source });
  const facts = await readGeminiTrustFacts({
    env: f.env,
    userHome: f.home,
    platform: process.platform,
    cwd: f.cwd,
  });
  expect(geminiWorkspaceTrust(facts)).toEqual({ state: "untrusted", denied: false });
  await writeFile(f.rules, JSON.stringify({ [f.source]: "TRUST_FOLDER", [f.cwd]: "DO_NOT_TRUST" }));
  expect(await f.read()).toEqual({ state: "untrusted", denied: true });
});

test("a parent rule covers siblings and a more specific refusal blocks inheritance", async () => {
  const f = await fixture();
  await writeFile(f.rules, JSON.stringify({ [join(f.source, "child")]: "TRUST_PARENT" }));
  expect(await f.read()).toEqual({ state: "inherited", from: f.source });
  await writeFile(
    f.rules,
    JSON.stringify({
      [f.home]: "TRUST_FOLDER",
      [f.source]: "DO_NOT_TRUST",
      [f.cwd]: "DO_NOT_TRUST",
    }),
  );
  expect(await f.read()).toEqual({ state: "untrusted", denied: true });
});

test("trust follows a checkout's real path without trusting a directory with a shared name prefix", async () => {
  const f = await fixture();
  const alias = join(f.home, "alias");
  await symlink(f.source, alias, "dir");
  await writeFile(f.rules, JSON.stringify({ [f.source]: "TRUST_FOLDER" }));
  expect(await f.read(alias)).toEqual({ state: "inherited", from: f.source });
  expect(await f.read(`${f.source}-other`)).toEqual({ state: "untrusted", denied: false });
});

test("invalid trust files cannot partially grant inherited trust", async () => {
  const f = await fixture();
  for (const text of [
    JSON.stringify({ [f.source]: "TRUST_FOLDER" }).slice(0, -1),
    JSON.stringify({ [f.source]: "TRUST_FOLDER", [f.cwd]: "future-level" }),
  ]) {
    await writeFile(f.rules, text);
    await expect(f.read()).rejects.toThrow(/Gemini/);
  }
});

test("system defaults, user settings and managed settings decide whether folder trust is enabled", async () => {
  const f = await fixture();
  await writeFile(
    join(f.home, "system-defaults.json"),
    '{"security":{"folderTrust":{"enabled":false}}}',
  );
  expect(await f.read()).toEqual({ state: "trusted" });
  await writeFile(
    join(f.home, ".gemini", "settings.json"),
    '{"security":{"folderTrust":{"enabled":true}}}',
  );
  expect(await f.read()).toEqual({ state: "untrusted", denied: false });
  await writeFile(join(f.home, "system.json"), '{"security":{"folderTrust":{"enabled":false}}}');
  expect(await f.read()).toEqual({ state: "trusted" });
});
