import { beforeAll, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { copyRepository, proxyGit, scalar, templateRepository } from "./test-repo.ts";

// Each command family proves that malformed Git output reaches its parser and surfaces as a
// typed error, with no refs left behind. The full tables of malformed records are unit tests of
// the parsers in malformed-output.test.ts. Checks that live inline in I/O code stay here.

const sha = "a".repeat(40);
const headers = `# branch.oid ${sha}\0# branch.head main\0`;
const ordinary = `1 M. N... 100644 100644 100644 ${sha} ${sha}`;

let template = "";
beforeAll(async () => {
  template = await templateRepository();
});

async function binaryFor(condition: string, output: string): Promise<string> {
  return proxyGit(
    `if (${condition}) { process.stdout.write(${JSON.stringify(output)}); process.exit(0); }`,
  );
}

test("malformed status rejects with a typed error", async () => {
  const repo = await copyRepository(template);
  const binary = await binaryFor(
    "args.includes('status')",
    `${headers}${ordinary.replace("M.", "Z.")} file\0`,
  );
  await expect(new GitService({ gitBinary: binary }).status(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test("malformed diff counts reject with a typed error", async () => {
  const repo = await copyRepository(template);
  const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
  const binary = await binaryFor(
    "args.includes('--raw')",
    `:100644 100644 ${blob} ${blob} M\0file\0-1\t0\tfile\0`,
  );
  await expect(
    new GitService({ gitBinary: binary }).diff({
      worktree: repo,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "commit", ref: "HEAD" },
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
});

test("malformed binary plumbing rejects a truncated blob", async () => {
  const repo = await copyRepository(template);
  const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
  const binary = await proxyGit(
    `if (args.includes('--raw')) {process.stdout.write(${JSON.stringify(`:100644 100644 ${blob} ${blob} M\0tracked.txt\x001\t1\ttracked.txt\0`)});process.exit(0);} if (args.includes('cat-file')) {process.stdout.write(${JSON.stringify(`${blob} blob 10\nshort`)});process.exit(0);}`,
  );
  await expect(
    new GitService({ gitBinary: binary }).diff({
      worktree: repo,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "commit", ref: "HEAD" },
    }),
  ).rejects.toMatchObject({ code: "malformed_output" });
});

test("malformed worktree list rejects with a typed error", async () => {
  const repo = await copyRepository(template);
  const binary = await binaryFor(
    "args.includes('worktree') && args.includes('list')",
    `worktree ../outside\0HEAD ${sha}\0branch refs/heads/main\0\0`,
  );
  await expect(new GitService({ gitBinary: binary }).listWorktrees(repo)).rejects.toMatchObject({
    code: "malformed_output",
  });
});

test.each([
  ["index path", `100644 ${sha} 0\t../file\0`, "args.includes('ls-files')"],
  ["tree hash", "abc\n", "args.includes('write-tree')"],
  ["commit hash", "abc\n", "args.includes('commit-tree')"],
  ["boolean config", "sometimes\n", "args.includes('core.sparseCheckout')"],
])("malformed snapshot rejects %s before creating refs", async (_name, output, condition) => {
  const repo = await copyRepository(template);
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
  ["metadata JSON", `${sha}\0${sha}\0not json\0`, "args.includes('log')"],
])("malformed checkpoint listing rejects %s", async (_name, output, condition) => {
  const repo = await copyRepository(template);
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
  ["remote arity", "remote.origin.url\0", "args.includes('--get-regexp')"],
  ["worktree boolean", "maybe\n", "args.includes('--is-inside-work-tree')"],
])("malformed repository metadata rejects %s", async (_name, output, condition) => {
  const repo = await copyRepository(template);
  const binary = await binaryFor(condition, output);
  await expect(new GitService({ gitBinary: binary }).repositoryInfo(repo)).rejects.toMatchObject({
    code: "malformed_output",
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
  const repo = await copyRepository(template);
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

test("malformed restore tree rejects and retains the safety checkpoint", async () => {
  const repo = await copyRepository(template);
  const saved = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "bad",
    label: "before",
  });
  const binary = await binaryFor("args.includes('ls-tree')", `100644 blob ${sha}\t../file\0`);
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
