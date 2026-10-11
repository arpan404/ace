import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { SourceControlContext, SourceControlSelection } from "@ace/protocol";
import { textOutput, patchOutput } from "./cli.ts";
import { withIndex } from "./temporary-index.ts";
import { within, type Repository } from "./repository.ts";
import { GitError } from "./types.ts";
import { parseDiff } from "./parse.ts";

/** Bounded repository text only. Symlinks and paths outside the checkout are never followed. */
async function repositoryText(root: string, path: string) {
  if (isAbsolute(path) || !within(root, join(root, path))) return undefined;
  try {
    const parent = await realpath(dirname(join(root, path)));
    if (!within(root, parent)) return undefined;
    const file = await open(
      join(parent, basename(path)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return undefined;
      const bytes = Buffer.alloc(16385);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytes.subarray(0, bytesRead).includes(0)) return undefined;
      return {
        text: bytes.subarray(0, Math.min(bytesRead, 16384)).toString("utf8"),
        truncated: bytesRead > 16384,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ELOOP", "ENOTDIR"].includes(String(error.code))
    )
      return undefined;
    throw error;
  }
}

/** Runs under the same repository lease as commit, so a draft guard and write are one operation. */
export async function writingContext(
  repository: Repository,
  root: string,
  input: SourceControlSelection,
): Promise<SourceControlContext> {
  const selection = SourceControlSelection.parse(input);
  const { branch, status } = await repository.state(root);
  if (status.conflicted.length)
    throw new GitError("conflicts", "Resolve conflicts before drafting");
  let base: string | null = null;
  let from: string;
  let to: string;
  if (selection.kind === "pr") {
    if (branch.branch !== selection.branch || !branch.head)
      throw new GitError("head_moved", "Branch changed");
    base = await repository.commit(root, selection.base);
    from = textOutput(await repository.cli.call(root, ["merge-base", base, branch.head]));
    to = branch.head;
  } else {
    const known = new Set([
      ...status.staged.flatMap((entry) =>
        entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
      ),
      ...status.unstaged.flatMap((entry) =>
        entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
      ),
      ...status.untracked,
    ]);
    if (selection.paths.some((path) => !known.has(path)))
      throw new GitError("head_moved", "Selected changes moved");
    from =
      branch.head ??
      textOutput(
        await repository.cli.call(root, ["hash-object", "-t", "tree", "--stdin"], {
          input: "",
          write: true,
        }),
      );
    to = await withIndex(repository.tempDirectory, async (env) => {
      await repository.cli.call(
        root,
        ["read-tree", ...(branch.head ? [branch.head] : ["--empty"])],
        { env, write: true },
      );
      await repository.cli.call(
        root,
        ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
        {
          env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
          write: true,
          input: [...new Set(selection.paths)].join("\0") + "\0",
        },
      );
      return textOutput(await repository.cli.call(root, ["write-tree"], { env, write: true }));
    });
  }
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    from,
    to,
    "--",
  ];
  const metadata = await repository.cli.call(root, [
    ...args.slice(0, -1),
    "--raw",
    "--no-abbrev",
    "--numstat",
    "-z",
    "--",
  ]);
  const entries = parseDiff(metadata.stdout);
  const paths = [
    ...new Set(
      entries.flatMap((file) =>
        file.entry.oldPath ? [file.entry.path, file.entry.oldPath] : [file.entry.path],
      ),
    ),
  ].toSorted();
  if (!paths.length) throw new GitError("invalid_argument", "No changes to describe");
  if (paths.length > 1000) throw new GitError("output_too_large", "Too many changes to describe");
  const patch = await repository.cli.call(
    root,
    [...args.slice(0, -1), "--patch", "--unified=3", "--"],
    { captureBytes: 65536 },
  );
  const recent = branch.head
    ? await repository.cli.call(root, ["log", "-12", "--format=%s", branch.head, "--"], {
        captureBytes: 8192,
      })
    : undefined;
  const configured = await repository.cli.call(root, ["config", "--get", "commit.template"], {
    allowFailure: true,
    captureBytes: 4096,
  });
  const candidates = new Set(["AGENTS.md", ".ace/source-control.md"]);
  if (selection.kind === "pr")
    for (const name of [
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/pull_request_template.md",
      "PULL_REQUEST_TEMPLATE.md",
    ])
      candidates.add(name);
  if (selection.kind === "commit" && configured.exitCode === 0) {
    const template = textOutput(configured);
    candidates.add(isAbsolute(template) ? relative(root, template) : template);
  }
  for (const path of paths) {
    let directory = dirname(path);
    while (directory !== "." && candidates.size < 32) {
      candidates.add(join(directory, "AGENTS.md"));
      directory = dirname(directory);
    }
  }
  const conventions: SourceControlContext["conventions"] = [];
  let conventionBytes = 0;
  let truncated = patch.truncated || (recent?.truncated ?? false) || candidates.size >= 32;
  for (const path of candidates) {
    const content = await repositoryText(root, path);
    if (!content) continue;
    const remaining = Math.max(0, 16384 - conventionBytes);
    const text = Buffer.from(content.text).subarray(0, remaining).toString("utf8");
    truncated ||= content.truncated || text.length < content.text.length;
    if (text) conventions.push({ path, text });
    conventionBytes += Buffer.byteLength(text);
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        selection:
          selection.kind === "commit"
            ? { kind: "commit", paths: [...new Set(selection.paths)].toSorted() }
            : selection,
        head: branch.head,
        branch: branch.branch,
        base,
        from,
        to,
        conventions,
      }),
    )
    .digest("hex");
  return SourceControlContext.parse({
    fingerprint,
    head: branch.head,
    base,
    paths,
    patch: patchOutput(patch),
    truncated,
    conventions,
    recentCommits: recent ? patchOutput(recent) : "",
  });
}
