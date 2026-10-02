import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { GitService } from "./src/index.ts";

const count = Number(process.argv[2] ?? 5000);
if (!Number.isSafeInteger(count) || count < 1)
  throw new Error("File count must be a positive integer");
const Service: typeof GitService = process.argv[3]
  ? (await import(pathToFileURL(resolve(process.argv[3])).href)).GitService
  : GitService;
const root = await mkdtemp(join(tmpdir(), "ace-git-diff-benchmark-"));
const repo = join(root, "repo");
const temporary = join(root, "indexes");
const observations = join(root, "sizes.jsonl");
const execute = promisify(execFile);
const git = async (...args: string[]) =>
  execute("git", args, {
    cwd: repo,
    timeout: 120_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
try {
  await mkdir(repo);
  await mkdir(temporary);
  await mkdir(join(repo, "files"));
  await git("init", "-b", "main");
  for (let start = 0; start < count; start += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, count - start) }, (_, i) =>
        writeFile(join(repo, "files", `${start + i}.txt`), "unchanged\n"),
      ),
    );
  await writeFile(join(repo, ".gitattributes"), "*.bin diff\n");
  await writeFile(join(repo, "one.bin"), Buffer.from("binary\0before\n"));
  await writeFile(join(repo, "visible.txt"), "before\n");
  await git("add", "--all");
  const commit = async () =>
    git(
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@ace.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-am",
      "Benchmark",
    );
  await commit();
  const before = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "one.bin"), Buffer.from("binary\0after\n"));
  await writeFile(join(repo, "visible.txt"), "after\n");
  await commit();
  const proxy = join(root, "git-proxy.cjs");
  await writeFile(
    proxy,
    `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2);const result=require('node:child_process').spawnSync('git',args,{maxBuffer:64*1024*1024,stdio:['inherit','pipe','pipe']});
 if(args.includes('write-tree')&&process.env.GIT_INDEX_FILE)fs.appendFileSync(${JSON.stringify(observations)},JSON.stringify(fs.statSync(process.env.GIT_INDEX_FILE).size)+'\\n');
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);\n`,
  );
  await chmod(proxy, 0o755);
  const service = new Service({ gitBinary: proxy, tempDirectory: temporary, timeoutMs: 120_000 });
  const start = performance.now();
  const diff = await service.diff({
    worktree: repo,
    from: { kind: "commit", ref: before },
    to: { kind: "commit", ref: "HEAD" },
  });
  const elapsed = performance.now() - start;
  if (
    !diff.entries.some((e) => e.binary) ||
    diff.patch.includes("\0") ||
    !diff.patch.includes("+after")
  )
    throw new Error("Binary/text diff behavior regressed");
  const sizes = z.array(z.number().int().nonnegative()).parse(
    (await readFile(observations, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  process.stdout.write(
    JSON.stringify({
      unchangedFiles: count,
      milliseconds: Math.round(elapsed),
      temporaryIndexBytes: sizes,
    }) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
