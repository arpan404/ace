import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { proxyGit, repository, scalar } from "./test-repo.ts";

const sha = "a".repeat(40);
const headers = `# branch.oid ${sha}\0# branch.head main\0`;
const ordinary = `1 M. N... 100644 100644 100644 ${sha} ${sha}`;
const rename = `2 R. N... 100644 100644 100644 ${sha} ${sha} R100`;

async function binaryFor(condition: string, output: string): Promise<string> {
  return proxyGit(
    `if (${condition}) { process.stdout.write(${JSON.stringify(output)}); process.exit(0); }`,
  );
}

test.each([
  ["record arity", "1 M. N...\0"],
  ["unknown status", `${ordinary.replace("M.", "Z.")} file\0`],
  ["ordinary conflict", `${ordinary.replace("M.", "UU")} file\0`],
  ["short hash", `${ordinary.replace(sha, "abcdef")} file\0`],
  ["nonhex hash", `${ordinary.replace(sha, "z".repeat(40))} file\0`],
  ["unknown mode", `${ordinary.replace("100644", "123456")} file\0`],
  ["submodule flag", `${ordinary.replace("N...", "NXXX")} file\0`],
  ["missing rename source", `${rename} file\0`],
  ["excessive similarity", `${rename.replace("R100", "R101")} file\0old\0`],
  ["mismatched rename status", `${rename.replace("R.", "M.")} file\0old\0`],
  ["absolute path", "? /outside\0"],
  ["traversal path", "? ../outside\0"],
  ["empty path", "? \0"],
  ["Git metadata path", "? .git/config\0"],
  ["invalid conflict", `u ZZ N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} file\0`],
  ["negative ahead", "# branch.ab +-1 -0\0"],
  ["infinite count", "# branch.ab +Infinity -0\0"],
  ["unsafe count", "# branch.ab +9007199254740992 -0\0"],
  ["extra count field", "# branch.ab +1 -0 extra\0"],
  ["unknown header", "# unknown value\0"],
  ["duplicate header", "# branch.head other\0"],
  ["unterminated record", "? file"],
])("malformed status rejects %s with a typed error", async (_name, record) => {
  const repo = await repository();
  const binary = await binaryFor("args.includes('status')", headers + record);
  await expect(new GitService({ gitBinary: binary }).status(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test.each([
  ["raw arity", `:100644 100644 ${sha} M\0file\0`],
  ["unknown status", `:100644 100644 ${sha} ${sha} Z\0file\0`],
  ["short hash", `:100644 100644 abc ${sha} M\0file\0`],
  ["missing rename destination", `:100644 100644 ${sha} ${sha} R100\0file\0`],
  ["negative additions", "-1\t0\tfile\0"],
  ["NaN additions", "NaN\t0\tfile\0"],
  ["infinite deletions", "1\tInfinity\tfile\0"],
  ["unsafe additions", "9007199254740992\t0\tfile\0"],
  ["half binary count", "-\t1\tfile\0"],
  ["extra numstat field", "1\t0\tfile\textra\0"],
  ["missing numstat", ""],
  ["wrong path", "1\t0\tother\0"],
])("malformed diff rejects %s with a typed error", async (_name, record) => {
  const repo = await repository();
  const raw = `:100644 100644 ${sha} ${sha} M\0file\0`;
  const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
  const output = (record.startsWith(":") ? record : raw + record).replaceAll(sha, blob);
  const binary = await binaryFor("args.includes('--raw')", output);
  await expect(
    new GitService({ gitBinary: binary }).diff({
      worktree: repo,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "commit", ref: "HEAD" },
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
});

test.each([
  ["relative worktree path", `worktree ../outside\0HEAD ${sha}\0branch refs/heads/main\0\0`],
  ["short worktree HEAD", "worktree /tmp\0HEAD abc\0branch refs/heads/main\0\0"],
  ["incomplete worktree", "worktree /tmp\0\0"],
  ["extra flag field", "worktree /tmp\0detached extra\0\0"],
  ["missing worktree separator", `worktree /tmp\0HEAD ${sha}\0branch refs/heads/main\0`],
])("malformed worktree rejects %s with a typed error", async (_name, output) => {
  const repo = await repository();
  const binary = await binaryFor("args.includes('worktree') && args.includes('list')", output);
  await expect(new GitService({ gitBinary: binary }).listWorktrees(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test.each([
  ["index arity", "100644 abc\tfile\0", "args.includes('ls-files')"],
  ["index stage", `100644 ${sha} 9\tfile\0`, "args.includes('ls-files')"],
  ["index path", `100644 ${sha} 0\t../file\0`, "args.includes('ls-files')"],
  ["tree hash", "abc\n", "args.includes('write-tree')"],
  ["commit hash", "abc\n", "args.includes('commit-tree')"],
  ["boolean config", "sometimes\n", "args.includes('core.sparseCheckout')"],
])("malformed snapshot rejects %s before creating refs", async (_name, output, condition) => {
  const repo = await repository();
  const binary = await binaryFor(condition, output);
  await expect(
    new GitService({ gitBinary: binary }).createCheckpoint({
      worktree: repo,
      threadId: "bad",
      label: "bad",
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
  expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
});

test.each([
  ["ref arity", `refs/ace/checkpoints/bad/1\0${sha}\0extra\n`, "args.includes('for-each-ref')"],
  ["ref hash", "refs/ace/checkpoints/bad/1\0abc\n", "args.includes('for-each-ref')"],
  ["ref namespace", `refs/ace/checkpoints/other/1\0${sha}\n`, "args.includes('for-each-ref')"],
  ["invalid ref sequence", `refs/ace/checkpoints/bad/0\0${sha}\n`, "args.includes('for-each-ref')"],
  ["commit arity", `${sha}\0`, "args.includes('log')"],
  ["commit tree", `${sha}\0abc\0{}\0`, "args.includes('log')"],
  ["metadata JSON", `${sha}\0${sha}\0not json\0`, "args.includes('log')"],
  [
    "metadata timestamp",
    `${sha}\0${sha}\0${JSON.stringify({ format: "ace-checkpoint-v1", threadId: "bad", label: "bad", createdAt: "yesterday" })}\0`,
    "args.includes('log')",
  ],
])("malformed checkpoint listing rejects %s", async (_name, output, condition) => {
  const repo = await repository();
  const saved = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "bad",
    label: "bad",
  });
  const binary = await binaryFor(
    condition,
    condition.includes("log") ? output.replaceAll(sha, saved.sha) : output,
  );
  await expect(
    new GitService({ gitBinary: binary }).listCheckpoints({ repo, threadId: "bad" }),
  ).rejects.toMatchObject({ code: "malformed_output" });
});

test.each([
  ["wrong blob type", "tree 0\n\n"],
  ["negative blob size", "blob -1\n"],
  ["infinite blob size", "blob Infinity\n"],
  ["truncated blob", "blob 10\nshort"],
  ["bad blob separator", "blob 0\nx"],
])("malformed binary plumbing rejects %s", async (_name, suffix) => {
  const repo = await repository();
  const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
  const binary = await proxyGit(
    `if (args.includes('--raw')) {process.stdout.write(${JSON.stringify(`:100644 100644 ${blob} ${blob} M\0tracked.txt\x001\t1\ttracked.txt\0`)});process.exit(0);} if (args.includes('cat-file')) {process.stdout.write(${JSON.stringify(blob + " " + suffix)});process.exit(0);}`,
  );
  await expect(
    new GitService({ gitBinary: binary }).diff({
      worktree: repo,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "commit", ref: "HEAD" },
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
});

test.each([
  ["remote arity", "remote.origin.url\0", "args.includes('--get-regexp')"],
  ["remote key", "remote.origin.other\nurl\0", "args.includes('--get-regexp')"],
  ["remote URL", "remote.origin.url\n\0", "args.includes('--get-regexp')"],
  ["worktree boolean", "maybe\n", "args.includes('--is-inside-work-tree')"],
])("malformed repository metadata rejects %s", async (_name, output, condition) => {
  const repo = await repository();
  const binary = await binaryFor(condition, output);
  await expect(new GitService({ gitBinary: binary }).repositoryInfo(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test("invalid UTF-8 path bytes are rejected rather than replaced", async () => {
  const repo = await repository();
  const binary = await proxyGit(
    `if(args.includes('status')) {process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(headers + "? ")}),Buffer.from([255,0])]));process.exit(0);}`,
  );
  await expect(new GitService({ gitBinary: binary }).status(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test("well-formed custom CLI records preserve unusual paths and exact counts", async () => {
  const repo = await repository();
  const path = "space tab\tnewline\n雪.txt";
  const output = `${headers}${ordinary} ${path}\0? untracked\n雪\0`;
  const binary = await binaryFor("args.includes('status')", output);
  expect(await new GitService({ gitBinary: binary }).status(repo)).toEqual({
    staged: [{ path, indexStatus: "M", worktreeStatus: ".", submodule: "N..." }],
    unstaged: [],
    untracked: ["untracked\n雪"],
    conflicted: [],
  });
});

test.each([
  ["counter framing", `${sha}\0{}\n`],
  ["counter hash", "abc\0{}\0\n"],
  [
    "counter sequence",
    `${sha}\0${JSON.stringify({ format: "ace-checkpoint-v1", threadId: "bad", label: "bad", createdAt: "2025-01-01T00:00:00.000Z", sequence: -1 })}\0\n`,
  ],
])("malformed durable counter rejects %s without creating a checkpoint", async (_name, output) => {
  const repo = await repository();
  const binary = await binaryFor("args.includes('show')", output);
  await expect(
    new GitService({ gitBinary: binary }).createCheckpoint({
      worktree: repo,
      threadId: "bad",
      label: "bad",
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
  expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
});

test.each([
  ["tree arity", `100644 ${sha}\tfile\0`],
  ["tree type", `100644 other ${sha}\tfile\0`],
  ["tree mode/type", `100644 tree ${sha}\tfile\0`],
  ["tree path", `100644 blob ${sha}\t../file\0`],
])("malformed restore tree rejects %s and retains the safety checkpoint", async (_name, output) => {
  const repo = await repository();
  const saved = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "bad",
    label: "before",
  });
  const binary = await binaryFor("args.includes('ls-tree')", output);
  await expect(
    new GitService({ gitBinary: binary }).restoreCheckpoint({
      worktree: repo,
      checkpoint: saved.id,
    }),
  ).rejects.toMatchObject({
    code: "malformed_output",
    details: { safetyCheckpointId: "refs/ace/checkpoints/bad/2" },
  });
  expect(await scalar(repo, "rev-parse", "refs/ace/checkpoints/bad/2")).toMatch(/^[a-f0-9]{40}$/);
});
