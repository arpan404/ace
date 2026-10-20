// Counts the Git processes the daemon's background workspace refresh spawns. Real Git, real
// SQLite and the production WorkspaceRefresh; only the timer is virtual, so ten idle minutes
// take seconds. Everything lives under a fresh temporary HOME: no real repository or ~/.ace.
//
//   node apps/daemon/bench/git-spawns.ts [--output=result.json]
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnGitProcess } from "@ace/git";
import { Thread, ThreadId, type ThreadStatus } from "@ace/protocol";
import { migrateEngine } from "../src/engine/migrations.ts";
import { Store } from "../src/store.ts";
import { WorkspaceRefresh } from "../src/workspace-refresh.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { VirtualSchedule } from "../src/virtual-schedule-test-support.ts";

const home = await realpath(await mkdtemp(join(tmpdir(), "ace-git-spawns-")));
// The daemon's Git children inherit HOME: keep the person's own Git config out of the run.
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-C", cwd, "-c", "user.name=Bench", "-c", "user.email=bench@ace.invalid", ...args]);

const repo = join(home, "repo");
await mkdir(repo);
await run("git", ["init", "-q", "-b", "main", repo]);
for (let dir = 0; dir < 40; dir++) {
  await mkdir(join(repo, `src${dir}`));
  for (let file = 0; file < 50; file++)
    await writeFile(join(repo, `src${dir}`, `f${file}.ts`), `export const v${file} = ${dir};\n`);
}
await git(repo, "add", "-A");
await git(repo, "commit", "-qm", "Initial");
const trees: string[] = [];
for (let index = 0; index < 4; index++) {
  const path = join(home, `worktree-${index}`);
  await git(repo, "worktree", "add", "-q", "-b", `task-${index}`, path);
  await writeFile(join(path, "src0", "f0.ts"), `export const changed = ${index};\n`);
  await writeFile(join(path, `notes-${index}.md`), "untracked\n");
  trees.push(await realpath(path));
}

// Virtual minutes pass in real milliseconds: let the fixture's config files age as they would.
await new Promise((resolve) => setTimeout(resolve, 2_500));
const clock = new VirtualSchedule();
const store = new Store(join(home, "events.sqlite"));
store.atomic((db) => migrateEngine(db));
const workspaceId = store.createWorkspace(repo, "Project");
const statuses: ThreadStatus[] = [{ state: "done" }, { state: "new" }];
const threads: { id: ThreadId; cwd: string; protected: boolean }[] = [];
const create = (id: string, status: ThreadStatus, worktree?: string) => {
  const thread = Thread.parse({
    id,
    workspaceId,
    provider: "codex",
    title: id,
    status,
    createdAt: 1,
    updatedAt: 1,
    ...(worktree ? { details: { mode: "worktree", worktree } } : {}),
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }], clock.at);
  if (worktree)
    store.atomic((db) =>
      db.prepare("INSERT INTO engine_sessions(thread_id,cwd) VALUES (?,?)").run(id, worktree),
    );
  threads.push({ id: thread.id, cwd: worktree ?? repo, protected: worktree !== undefined });
};
for (let index = 0; index < 2; index++)
  create(`local-${index}`, statuses[index % 2] ?? { state: "done" });
for (const [index, tree] of trees.entries())
  create(`agent-${index}`, statuses[index % 2] ?? { state: "done" }, tree);

const spawns: { at: number; args: string[] }[] = [];
const runtime = new WorkspaceRuntime(store, home, () => clock.at, {
  git: {
    processRuntime: {
      spawn(binary, args, options) {
        spawns.push({ at: clock.at, args: args.filter((arg) => arg !== "--no-pager") });
        return spawnGitProcess(binary, args, options);
      },
    },
  },
});
// Agent-created worktrees are non-executing roots, as the creation journal records them.
for (const tree of trees) runtime.git.protectWorktree(tree);

/** "status", "worktree list", "config --get-regexp ^(filter…" (execution keys), … */
const caller = (args: string[]) => {
  const plain = args[0] === "-c" ? args.slice(2) : args;
  if (plain.includes("^(filter\\..*\\.(clean|smudge|process|required)|hook\\..*\\.[^.]+)$"))
    return "config (execution keys)";
  if (plain[0] === "config") return "config (remotes)";
  return plain[0] === "worktree" || plain[0] === "rev-parse" || plain[0] === "diff"
    ? `${plain[0]} ${plain[1] ?? ""}`.trim()
    : (plain[0] ?? "?");
};
const phases: Record<string, { minutes: number; spawns: number; perMinute: number; by: object }> =
  {};
const measure = async (name: string, minutes: number, work?: () => Promise<void>) => {
  const start = spawns.length;
  await work?.();
  await clock.advance(minutes * 60_000);
  const taken = spawns.slice(start);
  const by: Record<string, number> = {};
  for (const spawn of taken) by[caller(spawn.args)] = (by[caller(spawn.args)] ?? 0) + 1;
  phases[name] = {
    minutes,
    spawns: taken.length,
    perMinute: Math.round((taken.length / minutes) * 10) / 10,
    by: Object.fromEntries(Object.entries(by).toSorted((a, b) => b[1] - a[1])),
  };
};

const refresh = new WorkspaceRefresh(store, runtime, () => clock.at, clock.schedule);
// The startup sweep and the head watch both arm once settled.
await clock.armedAtLeast(2);
const startup = spawns.length;
await measure("idle (UI closed)", 20);
const agent = threads.find((thread) => thread.protected);
if (!agent) throw new Error("No agent thread");
// A client opening a thread subscribes to it (the store holds it) and reads its details once.
store.acquireThread(agent.id);
await measure("one client viewing an agent thread", 20, async () => {
  await runtime.details(agent.id);
});
store.releaseThread(agent.id);
// An agent edit produces thread events; the next sweep must show the new file.
await measure("agent editing one thread", 10, async () => {
  await writeFile(join(agent.cwd, "edited-by-agent.ts"), "export {};\n");
  store.appendEvents(agent.id, [{ type: "thread.updated", title: "edited" }], clock.at);
});
const after = store.getThread(agent.id)?.details?.diff;
const perDetails = async (thread: (typeof threads)[number]) => {
  const before = spawns.length;
  await runtime.details(thread.id);
  return spawns.length - before;
};
const local = threads.find((thread) => !thread.protected);
if (!local) throw new Error("No local thread");
const result = {
  startupSpawns: startup,
  phases,
  spawnsPerDetailsRead: { local: await perDetails(local), protected: await perDetails(agent) },
  agentEditSeen: after?.files === 3,
};
await refresh.close();
await runtime.close();
store.close();
await rm(home, { recursive: true, force: true });
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const text = JSON.stringify(result, null, 2);
if (output) await writeFile(output, text + "\n");
process.stdout.write(text + "\n");
