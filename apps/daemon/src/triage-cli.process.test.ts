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

const parse = (stdout: string) =>
  JSON.parse(stdout) as { folder: string; playbook: string; facts: string; launch: string };

it("triage writes a playbook and this computer's facts without starting a daemon or touching ace data", async () => {
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
  const before = (await readdir(home)).toSorted();
  const result = await invoke(home, ["triage", "--json"], "", {
    PATH: "",
    ACE_TEST_TOKEN: "sk-live-abcdef1234567890",
  });
  expect(result.code).toBe(0);
  const session = parse(result.stdout);
  roots.push(session.folder);
  const facts = await readFile(session.facts, "utf8");
  expect(facts).toContain("2× error engine: Stop timed out");
  expect(facts).not.toContain("Old crash");
  expect(facts).not.toContain("Thread opened");
  expect(facts).not.toContain("sk-live-abcdef1234567890");
  expect(facts).toContain("ace daemon: stopped");
  expect(facts).toContain("Agent CLIs: none found");
  expect(facts).toMatch(/Never open: \S*daemon-token/);
  expect(await readFile(session.playbook, "utf8")).toContain(session.facts);
  expect(session.launch).toContain(session.playbook);
  expect((await readdir(home)).toSorted()).toEqual(before);
  expect(await readFile(join(home, "logs", "ace.jsonl"), "utf8")).toBe(log + "\n");
});

it("triage still writes its files when ace's settings are invalid and its log can't be read, and says so", async () => {
  const { home } = await setup();
  // A directory where the log file should be makes every read of it fail.
  await mkdir(join(home, "logs", "ace.jsonl"), { recursive: true, mode: 0o700 });
  const result = await invoke(home, ["triage", "--print"], "", {
    PATH: "",
    ACE_PORT: "not-a-port",
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("# ace triage playbook");
  expect(result.stdout).toContain("## Couldn't check");
  expect(result.stdout).toContain("ACE_PORT");
  expect(result.stdout).toMatch(/Reading \S*logs\/ace\.jsonl failed/);
});

it("doctor fix restores private folder access, creates logs and preserves data", async () => {
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
});

it("doctor without --fix lists the repairs it would make and changes nothing", async () => {
  const { home } = await setup();
  await chmod(home, 0o755);
  for (const args of [
    ["doctor", "--dry-run", "--fix", "--json"],
    ["doctor", "--json"],
  ]) {
    const output = JSON.parse((await invoke(home, args, "", { PATH: "" })).stdout);
    expect(output.planned).toContainEqual(
      expect.objectContaining({ id: "folders", recommended: true }),
    );
    expect(output.repairs).toEqual([]);
  }
  const text = await invoke(home, ["doctor"], "", { PATH: "" });
  expect(text.stdout).toContain("Fix ace folder access (recommended)");
  expect(text.stdout).toContain("pass --fix for the recommended ones");
  expect((await stat(home)).mode & 0o777).toBe(0o755);
  expect(await readdir(home)).toEqual([]);
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
