import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, git, proxyGit, put, repository, scalar } from "./test-repo.ts";

test("mixed binary and text diffs succeed within a writable-file quota smaller than the repository index", async (context) => {
  if (process.platform === "win32") context.skip("POSIX file-size limits are not available");
  try {
    await execute("python3", ["--version"]);
  } catch {
    context.skip("This resource-limit probe needs Python 3");
  }
  const repo = await repository({
    ".gitattributes": "*.bin diff\n",
    "binary.bin": Buffer.from("before\0PRIVATE\n"),
    "text.txt": "before\n",
  });
  for (let batch = 0; batch < 20; batch++)
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        put(repo, `unchanged/${batch * 100 + i}.txt`, "unchanged\n"),
      ),
    );
  await git(repo, "add", "--all");
  await git(repo, "commit", "-m", "Large repository");
  const before = await scalar(repo, "rev-parse", "HEAD");
  await put(repo, "binary.bin", Buffer.from("after\0PRIVATE\n"));
  await put(repo, "text.txt", "after\n");
  await git(repo, "commit", "-am", "Changes");
  // The OS enforces this limit on real Git writes. No internal call counts,
  // temporary-index shape checks, sleeps or wall-clock performance assertions.
  const binary = await proxyGit(`if(process.env.GIT_INDEX_FILE){
  const code='import os,resource,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(4096,4096)); os.execvp("git",["git"]+sys.argv[1:])';
  const child=spawn('python3',['-c',code,...args],{stdio:'inherit',shell:false});
  child.on('error',()=>process.exit(70));child.on('close',code=>process.exit(code ?? 71));return;
 }`);
  const result = await new GitService({ gitBinary: binary }).diff({
    worktree: repo,
    from: { kind: "commit", ref: before },
    to: { kind: "commit", ref: "HEAD" },
  });
  expect(result.entries).toEqual(
    expect.arrayContaining([
      { path: "binary.bin", status: "M", binary: true, additions: 0, deletions: 0 },
      { path: "text.txt", status: "M", binary: false, additions: 1, deletions: 1 },
    ]),
  );
  expect(result.patch).toContain("-before\n+after");
  expect(result.patch).not.toContain("PRIVATE");
  expect(result.patch).not.toContain("\0");
});
