import { describe, expect, test } from "vitest";
import { BlobClassifier } from "./blob-classifier.ts";
import { parseCommits } from "./checkpoint-metadata.ts";
import { parseIndex, parseTree } from "./parse-index.ts";
import { parseDiff, parseRemotes, parseStatus, parseWorktrees } from "./parse.ts";

// Git output is untrusted input. Every parser refuses anything it can't read exactly with a
// typed `malformed_output` error instead of guessing. The wiring from each Git command to these
// parsers is proved once per command family in malformed.process.test.ts.

const sha = "a".repeat(40);
const headers = `# branch.oid ${sha}\0# branch.head main\0`;
const ordinary = `1 M. N... 100644 100644 100644 ${sha} ${sha}`;
const rename = `2 R. N... 100644 100644 100644 ${sha} ${sha} R100`;

function failure(parse: () => unknown): unknown {
  try {
    parse();
  } catch (error) {
    return error;
  }
  throw new Error("Malformed output was accepted");
}

function rejectsMalformed(parse: () => unknown): void {
  expect(failure(parse)).toMatchObject({ code: "malformed_output" });
}

describe("status", () => {
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
  ])("rejects %s with a typed error", (_name, record) => {
    rejectsMalformed(() => parseStatus(Buffer.from(headers + record)));
  });

  test("invalid UTF-8 path bytes are rejected rather than replaced", () => {
    rejectsMalformed(() =>
      parseStatus(Buffer.concat([Buffer.from(`${headers}? `), Buffer.from([255, 0])])),
    );
  });

  test("well-formed records preserve unusual paths exactly", () => {
    const path = "space tab\tnewline\n雪.txt";
    expect(
      parseStatus(Buffer.from(`${headers}${ordinary} ${path}\0? untracked\n雪\0`)).status,
    ).toEqual({
      staged: [{ path, indexStatus: "M", worktreeStatus: ".", submodule: "N..." }],
      unstaged: [],
      untracked: ["untracked\n雪"],
      conflicted: [],
    });
  });
});

describe("diff", () => {
  const raw = `:100644 100644 ${sha} ${sha} M\0file\0`;
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
  ])("rejects %s with a typed error", (_name, record) => {
    rejectsMalformed(() => parseDiff(Buffer.from(record.startsWith(":") ? record : raw + record)));
  });
});

describe("blob stream", () => {
  test.each([
    ["wrong blob type", "tree 0\n\n"],
    ["negative blob size", "blob -1\n"],
    ["infinite blob size", "blob Infinity\n"],
    ["truncated blob", "blob 10\nshort"],
    ["bad blob separator", "blob 0\nx"],
  ])("rejects %s", (_name, suffix) => {
    rejectsMalformed(() => {
      const classifier = new BlobClassifier([sha]);
      classifier.feed(Buffer.from(`${sha} ${suffix}`));
      return classifier.finish();
    });
  });
});

describe("worktree list", () => {
  test.each([
    ["relative worktree path", `worktree ../outside\0HEAD ${sha}\0branch refs/heads/main\0\0`],
    ["short worktree HEAD", "worktree /tmp\0HEAD abc\0branch refs/heads/main\0\0"],
    ["incomplete worktree", "worktree /tmp\0\0"],
    ["extra flag field", "worktree /tmp\0detached extra\0\0"],
    ["missing worktree separator", `worktree /tmp\0HEAD ${sha}\0branch refs/heads/main\0`],
  ])("rejects %s with a typed error", (_name, output) => {
    rejectsMalformed(() => parseWorktrees(Buffer.from(output)));
  });
});

describe("remotes", () => {
  test.each([
    ["remote arity", "remote.origin.url\0"],
    ["remote key", "remote.origin.other\nurl\0"],
    ["remote URL", "remote.origin.url\n\0"],
  ])("rejects %s", (_name, output) => {
    rejectsMalformed(() => parseRemotes(Buffer.from(output)));
  });
});

describe("checkpoint snapshot and restore", () => {
  test.each([
    ["index arity", "100644 abc\tfile\0"],
    ["index stage", `100644 ${sha} 9\tfile\0`],
    ["index path", `100644 ${sha} 0\t../file\0`],
  ])("index rejects %s", (_name, output) => {
    rejectsMalformed(() => parseIndex(Buffer.from(output)));
  });

  test.each([
    ["tree arity", `100644 ${sha}\tfile\0`],
    ["tree type", `100644 other ${sha}\tfile\0`],
    ["tree mode/type", `100644 tree ${sha}\tfile\0`],
    ["tree path", `100644 blob ${sha}\t../file\0`],
  ])("tree rejects %s", (_name, output) => {
    rejectsMalformed(() => parseTree(Buffer.from(output)));
  });

  test.each([
    ["commit arity", `${sha}\0`],
    ["commit tree", `${sha}\0abc\0{}\0`],
    ["metadata JSON", `${sha}\0${sha}\0not json\0`],
    [
      "metadata timestamp",
      `${sha}\0${sha}\0${JSON.stringify({ format: "ace-checkpoint-v1", threadId: "bad", label: "bad", createdAt: "yesterday" })}\0`,
    ],
  ])("commit listing rejects %s", (_name, output) => {
    rejectsMalformed(() => parseCommits(Buffer.from(output)));
  });
});
