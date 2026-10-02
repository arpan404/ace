import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "@ace/git";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0`;
async function boundary(metadata: string, mode = "diff") {
  const dir = await mkdtemp(join(tmpdir(), "ace-orch-boundary-"));
  const worktree = join(dir, "repo");
  await exec("git", ["init", "-b", "main", worktree]);
  const cli = async (...args: string[]) => exec("git", ["-C", worktree, ...args]);
  await cli("config", "user.name", "Boundary test");
  await cli("config", "user.email", "test@example.invalid");
  await writeFile(join(worktree, "file"), "base\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  const payload = join(dir, "metadata");
  await writeFile(payload, metadata);
  const binary = join(dir, "git-wrapper");
  const actualGit = (await exec("which", ["git"])).stdout.trim();
  await writeFile(
    binary,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const inject = ${JSON.stringify(mode)} === "diff"
  ? args.includes("--raw") && args.includes("--numstat")
  : args.some(arg => arg.startsWith("--format=%T") || arg.startsWith("--format=%H"));
if (inject) {
  const bytes = readFileSync(${JSON.stringify(payload)});
  process.stdout.write(args.some(arg => arg.startsWith("--format=%T")) ? bytes.subarray(bytes.indexOf(0) + 1) : bytes);
}
else process.exit(spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit" }).status ?? 1);
`,
  );
  await chmod(binary, 0o755);
  return { dir, worktree, binary, cli, payload };
}

it.each([
  [
    "unknown status and nonnumeric count",
    ":100644 100644 aaaaaaa bbbbbbb Z\0file\0oops\t0\tfile\0",
  ],
  ["unknown status", `${raw.replace(" M\0", " Z\0")}file\x000\t0\tfile\0`],
  ["nonnumeric count", `${raw}file\0oops\t0\tfile\0`],
  ["negative count", `${raw}file\0-1\t0\tfile\0`],
  ["infinite count", `${raw}file\0Infinity\t0\tfile\0`],
  ["missing path", raw],
  ["incomplete numstat", `${raw}file\0`],
])(
  "Git diff rejects %s at the subprocess boundary",
  async (_name, metadata) => {
    const p = await boundary(metadata);
    try {
      const git = new GitService({ gitBinary: p.binary });
      await expect(
        git.diff({
          worktree: p.worktree,
          from: { kind: "commit", ref: "HEAD" },
          to: { kind: "commit", ref: "HEAD" },
        }),
      ).rejects.toMatchObject({ code: "malformed_output" });
    } finally {
      await rm(p.dir, { recursive: true, force: true });
    }
  },
  60_000,
);

it("Git checkpoint listing rejects a malformed tree instead of exposing typed metadata", async () => {
  const metadata = JSON.stringify({
    format: "ace-checkpoint-v1",
    threadId: "lane",
    label: "Result",
    createdAt: "2026-10-02T00:00:00.000Z",
    sequence: 1,
  });
  const p = await boundary(`invalid-tree\0${metadata}\n`, "checkpoint");
  try {
    const cp = await new GitService().createCheckpoint({
      worktree: p.worktree,
      threadId: "lane",
      label: "Result",
    });
    await writeFile(p.payload, `${cp.sha}\0invalid-tree\0${metadata}\0`);
    await expect(
      new GitService({ gitBinary: p.binary }).listCheckpoints({
        repo: p.worktree,
        threadId: "lane",
      }),
    ).rejects.toMatchObject({ code: "malformed_output" });
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
}, 60_000);

it("Git checkpoints use the service clock in persisted metadata and commit dates", async () => {
  const p = await boundary("");
  try {
    const stamp = "2020-01-02T03:04:05.000Z";
    const options = { gitBinary: p.binary, now: () => new Date(stamp), tempDirectory: p.dir };
    const git = new GitService(options);
    const cp = await git.createCheckpoint({
      worktree: p.worktree,
      threadId: "lane",
      label: "Result",
    });
    expect(cp.createdAt).toBe(stamp);
    const saved = await new GitService(options).listCheckpoints({
      repo: p.worktree,
      threadId: "lane",
    });
    expect(saved[0]?.createdAt).toBe(stamp);
    expect(
      new Date((await p.cli("show", "-s", "--format=%aI", cp.sha)).stdout.trim()).toISOString(),
    ).toBe(stamp);
    expect((await readdir(p.dir)).filter((name) => name.startsWith("ace-git-index-"))).toEqual([]);
    expect(await readFile(join(p.worktree, "file"), "utf8")).toBe("base\n");
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
}, 60_000);

it("Git checkpoints honor the injected temporary root rather than escaping to the host root", async () => {
  const p = await boundary("");
  try {
    const options = { gitBinary: p.binary, tempDirectory: join(p.dir, "missing-root") };
    await expect(
      new GitService(options).createCheckpoint({
        worktree: p.worktree,
        threadId: "lane",
        label: "Result",
      }),
    ).rejects.toMatchObject({ code: "filesystem_error" });
    expect(await new GitService().listCheckpoints({ repo: p.worktree, threadId: "lane" })).toEqual(
      [],
    );
    expect(await readFile(join(p.worktree, "file"), "utf8")).toBe("base\n");
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
}, 60_000);
