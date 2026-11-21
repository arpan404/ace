import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SpadeCall } from "./spade-bots.ts";
import { importSkill } from "./spade-skills.ts";

// A real git repository: the import reads a skill's folder through the plugin fetcher's shallow
// bare fetch, which a unit test of the folder logic can't stand in for.

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("imports one skill's folder from a git repository, naming where it came from", async () => {
  const repo = await mkdtemp(join(tmpdir(), "skill-repo-"));
  dirs.push(repo);
  const skill = join(repo, "skills", "triage-mail");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: triage-mail\ndescription: Sorts mail.\n---\n# Triage mail\n",
  );
  await writeFile(join(skill, "scripts/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "skill");

  const sent: { name: string; files: { path: string; executable: boolean }[] }[] = [];
  const call: SpadeCall = async (_method, _path, body) => {
    sent.push(body as (typeof sent)[number]);
    return JSON.stringify({ id: "sks_1" });
  };
  const imported = await importSkill(call, {
    from: repo,
    git: true,
    path: "skills/triage-mail",
    replace: false,
  });
  expect(imported).toMatchObject({ name: "triage-mail", source: `${repo}#skills/triage-mail` });
  expect(sent[0]?.files.map((file) => [file.path, file.executable])).toEqual([
    ["scripts/run.sh", true],
  ]);
});
