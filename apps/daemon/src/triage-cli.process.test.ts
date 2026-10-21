import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  rm,
  readdir,
  mkdir,
  chmod,
  stat,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "./cli-test-support.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-triage-"));
  roots.push(root);
  const home = join(root, "data");
  await mkdir(home, { mode: 0o700 });
  return { root, home };
}
it("piped triage generates a feature prompt without starting a daemon or writing ace data", async () => {
  const { home } = await setup();
  const result = await invoke(
    home,
    ["triage", "-", "--kind", "feature", "--provider", "codex", "--json"],
    "Add inbox filtering",
    { PATH: "" },
  );
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.prompt).toContain("Add inbox filtering");
  expect(output.prompt).toContain("acceptance criteria");
  expect(output.prompt).not.toContain("ace doctor results");
  expect(output.prompt).not.toContain("Working agreement");
  expect(output.provider).toBe("codex");
  expect(await readdir(home)).toEqual([]);
});
it("doctor fix restores private folder access, creates logs, preserves data and exports unresolved findings", async () => {
  const { home } = await setup();
  await writeFile(join(home, "precious-data"), "keep me");
  await chmod(home, 0o755);
  const result = await invoke(home, ["doctor", "--fix", "--json"], "", { PATH: "" });
  const output = JSON.parse(result.stdout);
  expect(output.repairs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "home.permissions", status: "fixed" }),
      expect.objectContaining({ id: "logs.directory", status: "fixed" }),
    ]),
  );
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  expect((await stat(join(home, "logs"))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(home, "precious-data"), "utf8")).toBe("keep me");
  expect(
    output.checks.find((check: { id: string }) => check.id === "home.permissions").status,
  ).toBe("ok");
  expect(output.prompt).toContain("ace doctor results");
});
it("doctor fix refuses linked log folders without changing their target", async () => {
  const { root, home } = await setup();
  const outside = join(root, "outside");
  await mkdir(outside, { mode: 0o755 });
  await symlink(outside, join(home, "logs"));
  const result = await invoke(home, ["doctor", "--fix", "--json"], "", { PATH: "" });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).repairs).toContainEqual(
    expect.objectContaining({ id: "logs.directory", status: "failed" }),
  );
  expect((await stat(outside)).mode & 0o777).toBe(0o755);
});
it("invalid triage and doctor options are rejected before repairing folders", async () => {
  const { home } = await setup();
  for (const args of [
    ["doctor", "--fix", "--provider", "unknown", "--json"],
    ["triage", "text", "--kind", "unknown", "--json"],
    ["doctor", "--fix", "--unexpected", "value", "--json"],
  ])
    expect((await invoke(home, args)).code).toBe(4);
  expect(await readdir(home)).toEqual([]);
});
