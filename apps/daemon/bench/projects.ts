// Merge-time measurement only. Do not run during development under the owner's rule.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProjectsRequest } from "@ace/protocol";
import { Store } from "../src/store.ts";
import { Projects } from "../src/projects.ts";

const root = await realpath(await mkdtemp(join(homedir(), ".ace-project-bench-")));
const store = new Store(join(root, "events.sqlite"));
const projects = new Projects(store, () => 0, { home: root, roots: async () => [root] });
let requestId = 0;
async function measure(label: string, operation: ProjectsRequest["operation"]) {
  const times: number[] = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    const result = await projects.read(
      ProjectsRequest.parse({
        type: "projects.request",
        requestId: `bench-${++requestId}`,
        operation,
      }),
      "owner",
    );
    if (result.result.kind === "error") throw new Error(result.result.code);
    if (i > 0) times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      label,
      samples: times.length,
      medianMs: times[Math.floor(times.length / 2)],
      maximumMs: times.at(-1),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
}
async function populate(from: number, to: number, entry: (index: number) => Promise<unknown>) {
  for (let offset = from; offset < to; offset += 128)
    await Promise.all(
      Array.from({ length: Math.min(128, to - offset) }, (_, index) => entry(offset + index)),
    );
}
try {
  const repo = join(root, "repo"),
    picker = join(root, "picker");
  await mkdir(repo);
  await mkdir(picker);
  await promisify(execFile)("git", ["init", "--initial-branch=main"], { cwd: repo });
  let previous = 0;
  for (const count of [0, 1000, 10_000]) {
    await populate(previous, count, (index) => writeFile(join(repo, `untracked-${index}`), "data"));
    await measure(`inspect: ${count} untracked files`, { op: "workspace.inspect", path: repo });
    previous = count;
  }
  previous = 0;
  for (const count of [0, 100, 10_000]) {
    await populate(previous, count, (index) =>
      mkdir(join(picker, `folder-${String(index).padStart(5, "0")}`)),
    );
    await measure(`browse: ${count} folders, page 100`, {
      op: "fs.browse",
      path: picker,
      limit: 100,
      showHidden: false,
    });
    previous = count;
  }
} finally {
  await projects.close();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
