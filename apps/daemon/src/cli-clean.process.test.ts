import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { StoragePlan, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
import { parseArgs } from "./cli/args.ts";
import { connectCli } from "./cli/connection.ts";
import { command } from "./cli/mutations.ts";

const day = 86_400_000;
const git = (root: string, ...args: string[]) => promisify(execFile)("git", ["-C", root, ...args]);

/** A temp ace home holding a rotated log and a finished, archived ace-created worktree. */
async function cleanFixture() {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    await mkdir(join(f.h.home, "repo"));
    const repo = await realpath(join(f.h.home, "repo"));
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "file.txt"), "original\n");
    await git(repo, "add", ".");
    await git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "-m",
      "Init",
    );
    // Prepared through the daemon's public command path, so ace records the worktree it created.
    // Temp dirs are system paths to project registration, so the workspace is seeded directly.
    const workspaceId = f.daemon.store.createWorkspace(repo, "repo");
    const threadId = ThreadId.parse("finished-worktree");
    const session = await connectCli(home, parseArgs([]));
    try {
      const prepare = { type: "thread.prepare", threadId, workspaceId, provider: "codex" };
      await command(
        session.client,
        { ...prepare, title: "Finished", mode: "worktree", base: { ref: "main" } },
        "prepare-worktree",
        session.signal,
      );
      await command(
        session.client,
        { type: "thread.archive", threadId },
        "archive-worktree",
        session.signal,
      );
    } finally {
      await session.close();
    }
    const worktree = f.daemon.store.getThread(threadId)?.details?.worktree;
    if (!worktree) throw new Error("Preparation created no worktree");
    // Published: the worktree head is reachable from a remote-tracking ref.
    await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    await mkdir(join(home, "logs"), { recursive: true });
    const oldLog = join(home, "logs/ace.1.jsonl"),
      currentLog = join(home, "logs/ace.jsonl");
    await writeFile(oldLog, "rotated");
    await utimes(oldLog, 0, 0);
    await writeFile(currentLog, "current");
    // Eight days on: past a 7-day threshold, within the 30-day worktree default.
    f.h.clock.advance(Date.now() + 8 * day);
    return { ...f, home, worktree, oldLog, currentLog };
  } catch (error) {
    await f.daemon.close();
    throw error;
  }
}

test("a dry run selecting worktrees older than 7 days plans only worktrees against that threshold", async () => {
  const f = await cleanFixture();
  try {
    const defaults = await invoke(f.home, ["clean", "--dry-run", "--worktrees", "--json"]);
    expect(defaults.code, defaults.stderr).toBe(0);
    expect(StoragePlan.parse(JSON.parse(defaults.stdout)).items).toEqual([
      expect.objectContaining({ kind: "worktrees", disposition: "protect" }),
    ]);
    const output = await invoke(f.home, [
      "clean",
      "--dry-run",
      "--worktrees",
      "--older-than",
      "7d",
      "--json",
    ]);
    expect(output.code, output.stderr).toBe(0);
    const plan = StoragePlan.parse(JSON.parse(output.stdout));
    expect(plan.retention).toEqual({
      threads: null,
      attachments: null,
      artifacts: null,
      logs: null,
      worktrees: 7,
      caches: null,
    });
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: "worktrees", disposition: "remove" }),
    ]);
    await access(f.worktree);
    expect(await readFile(f.oldLog, "utf8")).toBe("rotated");
  } finally {
    await f.daemon.close();
  }
});

test("clean --logs --yes applies the logs plan unattended and leaves the worktree alone", async () => {
  const f = await cleanFixture();
  try {
    const output = await invoke(f.home, ["clean", "--logs", "--yes", "--json"]);
    expect(output.code, output.stderr).toBe(0);
    const result = z
      .object({ plan: StoragePlan, apply: z.object({ planId: z.string(), state: z.string() }) })
      .parse(JSON.parse(output.stdout));
    expect(result.apply).toMatchObject({ planId: result.plan.id, state: "complete" });
    expect(result.plan.items.every((item) => item.kind === "logs")).toBe(true);
    await expect(access(f.oldLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.currentLog, "utf8")).toBe("current");
    await access(f.worktree);
  } finally {
    await f.daemon.close();
  }
});

test("clean is refused and removes nothing without consent, a kind for --older-than, or a forced preview", async () => {
  const f = await cleanFixture();
  try {
    for (const args of [
      ["clean"],
      ["clean", "--logs"],
      ["clean", "--worktrees", "--older-than", "7d", "--json"],
      ["clean", "--older-than", "1d", "--yes"],
      ["clean", "--logs", "--force-items", '["unused"]', "--yes"],
    ]) {
      const output = await invoke(f.home, args);
      expect(output.code, output.stderr).toBe(4);
    }
    expect(await readFile(f.oldLog, "utf8")).toBe("rotated");
    await access(f.worktree);
  } finally {
    await f.daemon.close();
  }
});

test("a connection dropped during apply exits uncertain with the plan ID and revision to resume", async () => {
  const f = await cleanFixture();
  const endpoint = join(f.home, "daemon-endpoint");
  const origin = await readFile(endpoint, "utf8");
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  const Apply = z.object({
    type: z.literal("storage.request"),
    operation: z.object({ op: z.literal("cleanup.apply") }),
  });
  let dropped = false;
  proxy.on("connection", (downstream) => {
    if (dropped) return downstream.terminate();
    const upstream = new WebSocket(origin.replace("http:", "ws:"));
    const opened = once(upstream, "open");
    downstream.on("message", (frame, binary) => {
      if (!binary && Apply.safeParse(JSON.parse(frame.toString())).success) {
        // Lose the connection before the daemon sees the apply.
        dropped = true;
        downstream.terminate();
        upstream.terminate();
        return;
      }
      void opened.then(() => upstream.send(frame, { binary })).catch(() => downstream.terminate());
    });
    upstream.on("message", (frame, binary) => {
      if (downstream.readyState === WebSocket.OPEN) downstream.send(frame, { binary });
    });
    upstream.on("error", () => downstream.terminate());
    downstream.on("close", () => upstream.terminate());
  });
  await writeFile(endpoint, `http://127.0.0.1:${address.port}/`, { mode: 0o600 });
  try {
    const output = await invoke(f.home, ["clean", "--logs", "--yes", "--json", "--timeout", "20s"]);
    expect(output.code, output.stderr).toBe(5);
    const failure = z
      .object({
        status: z.literal("uncertain"),
        admission: z.object({ planId: z.string(), revision: z.string() }),
      })
      .parse(JSON.parse(output.stdout));
    expect(dropped).toBe(true);
    expect(await readFile(f.oldLog, "utf8")).toBe("rotated");
    // The printed identity is enough to finish the same reviewed plan.
    await writeFile(endpoint, origin, { mode: 0o600 });
    const resumed = await invoke(f.home, [
      "clean",
      "apply",
      failure.admission.planId,
      "--revision",
      failure.admission.revision,
      "--json",
    ]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ state: "complete" });
    await expect(access(f.oldLog)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await writeFile(endpoint, origin, { mode: 0o600 });
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.daemon.close();
  }
});
