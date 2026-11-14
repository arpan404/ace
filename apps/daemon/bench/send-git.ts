// Times the Git work between Send and delivery (the "before" checkpoint) and the creation of a
// new worktree thread, on a generated 10,000-file repository, and counts the Git processes each
// spawns. Real Git, real SQLite and the production RunCheckpoints / WorkspaceCreations. All
// files live under a fresh temporary HOME: no real repository or ~/.ace is touched.
//
//   bun apps/daemon/bench/send-git.ts [--runs=5] [--output=result.json]
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnGitProcess } from "@ace/git";
import { Command, CommandId, Thread } from "@ace/protocol";
import { WorkspaceCreations } from "../src/creation-workspace.ts";
import { Store } from "../src/store.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";

const runs = Number(
  process.argv.find((arg) => arg.startsWith("--runs="))?.slice("--runs=".length) ?? 5,
);
const home = await realpath(await mkdtemp(join(tmpdir(), "ace-send-git-")));
// The daemon's Git children inherit HOME: keep the person's own Git config out of the run.
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-C", cwd, "-c", "user.name=Bench", "-c", "user.email=bench@ace.invalid", ...args]);

const repo = join(home, "repo");
await mkdir(repo);
await run("git", ["init", "-q", "-b", "main", repo]);
for (let dir = 0; dir < 100; dir++) {
  await mkdir(join(repo, `src${dir}`));
  await Promise.all(
    Array.from({ length: 100 }, (_, file) =>
      writeFile(join(repo, `src${dir}`, `f${file}.ts`), `export const v${file} = ${dir};\n`),
    ),
  );
}
await git(repo, "add", "-A");
await git(repo, "commit", "-qm", "Initial");
// A working checkout: one edit and one new file, as a person's tree usually has.
await writeFile(join(repo, "src0", "f0.ts"), "export const edited = true;\n");
await writeFile(join(repo, "notes.md"), "untracked\n");

const data = join(home, "data");
await mkdir(data);
const store = new Store(join(data, "events.sqlite"));
const workspaceId = store.createWorkspace(repo, "Project");
const thread = Thread.parse({
  id: "thread",
  workspaceId,
  provider: "codex",
  rootAgentId: "root",
  title: "Bench",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});
store.appendEvents(thread.id, [{ type: "thread.created", thread }]);

const spawns: string[][] = [];
const runtime = new WorkspaceRuntime(store, data, () => 1000, {
  git: {
    processRuntime: {
      spawn(binary, args, options) {
        spawns.push(args.filter((arg) => arg !== "--no-pager"));
        return spawnGitProcess(binary, args, options);
      },
    },
  },
});

const name = (args: string[]) => {
  let plain = args;
  while (plain[0] === "-c") plain = plain.slice(2);
  if (plain[0] === "config" && plain.some((arg) => arg.startsWith("^(filter")))
    return "config (execution keys)";
  return ["worktree", "rev-parse", "config", "ls-files"].includes(plain[0] ?? "")
    ? `${plain[0]} ${plain.find((arg, index) => index > 0 && arg.startsWith("-")) ?? plain[1] ?? ""}`.trim()
    : (plain[0] ?? "?");
};
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const measure = async (work: (index: number) => Promise<void>) => {
  const times: number[] = [];
  let counts: Record<string, number> = {};
  let total = 0;
  for (let index = 0; index < runs; index++) {
    const start = spawns.length;
    const began = performance.now();
    await work(index);
    times.push(Math.round(performance.now() - began));
    const taken = spawns.slice(start);
    total = taken.length;
    counts = {};
    for (const spawn of taken) counts[name(spawn)] = (counts[name(spawn)] ?? 0) + 1;
  }
  return {
    medianMs: median(times),
    times,
    spawns: total,
    by: Object.fromEntries(Object.entries(counts).toSorted((a, b) => b[1] - a[1])),
  };
};

// Warm the configuration caches as a running daemon would have them.
await runtime.checkpoints.beforeSend(thread.id, CommandId.parse("warm"));
const beforeSend = await measure((index) =>
  runtime.checkpoints.beforeSend(thread.id, CommandId.parse(`send-${index}`)),
);

const creations = new WorkspaceCreations(store, runtime.git, data, 15_000, () => 1000);
const worktreeCreate = await measure(async (index) => {
  const command = Command.parse({
    id: `create-${index}`,
    deviceId: "device",
    payload: {
      type: "thread.create",
      threadId: `created-${index}`,
      workspaceId,
      provider: "codex",
      mode: "worktree",
      base: { ref: "main" },
      input: [{ type: "text", text: "bench" }],
    },
  });
  const lease = await creations.prepareAgent(command, new AbortController().signal);
  if (!lease) throw new Error("No worktree created");
});

const result = { files: 10_000, runs, beforeSend, worktreeCreate };
await creations.close();
await runtime.close();
store.close();
await rm(home, { recursive: true, force: true });
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const text = JSON.stringify(result, null, 2);
if (output) await writeFile(output, text + "\n");
process.stdout.write(text + "\n");
