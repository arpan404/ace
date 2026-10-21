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
  expect(output.prompt).not.toContain("## ace doctor\n");
  expect(output.prompt).not.toContain("Working agreement");
  expect(output.provider).toBe("codex");
  expect(await readdir(home)).toEqual([]);
});
it("a bug prompt carries this computer's recent ace errors, grouped, without the noise or the secrets", async () => {
  const { home } = await setup();
  await mkdir(join(home, "logs"), { mode: 0o700 });
  const now = Date.now();
  const entry = (ago: number, level: string, message: string, data: unknown) =>
    JSON.stringify({ at: now - ago, level, component: "engine", message, data });
  const log = [
    entry(86_400_000 * 3, "error", "Old crash nobody cares about", {}),
    entry(60_000, "error", "Stop timed out", { thread: "t1" }),
    entry(30_000, "error", "Stop timed out", { token: "sk-live-abcdef1234567890" }),
    entry(10_000, "info", "Thread opened", {}),
  ].join("\n");
  await writeFile(join(home, "logs", "ace.jsonl"), log + "\n");
  const result = await invoke(
    home,
    ["triage", "-", "--kind", "bug", "--print"],
    "Stop leaves the thread working",
    { PATH: "", ACE_TEST_TOKEN: "sk-live-abcdef1234567890" },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Stop leaves the thread working");
  expect(result.stdout).toContain("2× error engine: Stop timed out");
  expect(result.stdout).not.toContain("Old crash");
  expect(result.stdout).not.toContain("Thread opened");
  expect(result.stdout).not.toContain("sk-live-abcdef1234567890");
  expect(result.stdout).toMatch(/Logs: \S*data\/logs\/ace\.jsonl/);
  expect(result.stdout).toContain("Agent CLIs: none found");
  expect(await readFile(join(home, "logs", "ace.jsonl"), "utf8")).toBe(log + "\n");
});
it("triage still writes a prompt when ace's settings are invalid and its log can't be read, and says so", async () => {
  const { home } = await setup();
  // A directory where the log file should be makes every read of it fail.
  await mkdir(join(home, "logs", "ace.jsonl"), { recursive: true, mode: 0o700 });
  const result = await invoke(
    home,
    ["triage", "-", "--kind", "bug", "--print"],
    "The app won't open after an update",
    { PATH: "", ACE_PORT: "not-a-port" },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("The app won't open after an update");
  expect(result.stdout).toContain("## Couldn't check");
  expect(result.stdout).toContain("ACE_* environment settings are invalid");
  expect(result.stdout).toMatch(/Reading \S*logs\/ace\.jsonl failed/);
  expect(result.stdout).toMatch(/Logs: \S*data\/logs\/ace\.jsonl/);
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
  expect(output.prompt).toContain("## ace doctor\n");
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
