import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GitCli } from "./src/cli.ts";
import { GitService } from "./src/index.ts";

const count = Number(process.argv[2] ?? 25_000);
if (!Number.isSafeInteger(count) || count < 1)
  throw new Error("File count must be a positive integer");
const repo = await mkdtemp(join(tmpdir(), "ace-git-benchmark-"));
const cli = new GitCli({ timeoutMs: 120_000 });
const git = async (...args: string[]) => {
  await cli.call(repo, args, { write: true });
};
try {
  await git("init", "-b", "main");
  await mkdir(join(repo, "files"));
  for (let start = 0; start < count; start += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          join(repo, "files", `${index}.txt`),
          `Synthetic file ${index}\n`.repeat(16),
        );
      }),
    );
  }
  await git("add", "--all");
  await git(
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@ace.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Synthetic repository",
  );
  const service = new GitService({ timeoutMs: 120_000 });
  for (const phase of ["first", "unchanged", "changed"]) {
    if (phase === "changed") {
      for (let i = 0; i < Math.min(count, 1_000); i++) {
        await writeFile(join(repo, "files", `${i}.txt`), `Changed ${i}\n`.repeat(16));
      }
    }
    const start = performance.now();
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "benchmark",
      label: phase,
    });
    process.stdout.write(
      JSON.stringify({
        phase,
        files: count,
        milliseconds: Math.round(performance.now() - start),
        checkpoint: checkpoint.id,
      }) + "\n",
    );
  }
} finally {
  await rm(repo, { recursive: true, force: true });
}
