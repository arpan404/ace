import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import { GitError, GitService, spawnGitProcess } from "./index.ts";
import { git, repository, scratch } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const journal = (repo: string) =>
  readdir(join(repo, ".git", "ace-mutation-leases")).catch(() => []);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A local port nothing listens on: the endpoint of a daemon that has stopped. */
async function stoppedDaemonPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The durable intent a daemon writes before it mutates `repo`, then never retires. */
async function leftLease(repo: string): Promise<string> {
  const directory = join(repo, ".git", "ace-mutation-leases");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const root = await realpath(repo);
  await writeFile(
    join(directory, id),
    JSON.stringify({
      version: 1,
      id,
      root,
      owner: { port: await stoppedDaemonPort(), token: randomUUID() },
      roots: [root],
    }),
  );
  return join(directory, id);
}

/** Someone else's Git, running in `repo` until stopped: the user's own terminal, say. */
async function heldGit(repo: string) {
  const marker = join(await scratch(), "held");
  const child = spawn(
    "git",
    ["-c", `alias.hold=!touch '${marker.replaceAll("\\", "/")}' && sleep 300`, "hold"],
    { cwd: repo, env: testGitEnvironment(), stdio: "ignore", windowsHide: true },
  );
  const exited = once(child, "exit");
  await expect.poll(() => exists(marker), { timeout: 20_000 }).toBe(true);
  return {
    async stop() {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      await exited;
    },
  };
}

describe.runIf(process.platform === "win32")("Windows Git cleanup", () => {
  test("a timed-out Windows Git call is ended with its descendants, confirmed, and its repository unlocks without a restart", async () => {
    const repo = await repository();
    const markers = await scratch();
    const grandchildPid = join(markers, "grandchild.pid");
    // The grandchild is detached and holds none of Git's pipes: only the job reaches it.
    const hang = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      require("node:fs").writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    let hung = false;
    const service = new GitService({
      timeoutMs: 8000,
      processRuntime: {
        spawn: (binary, args, options) => {
          if (hung || !args.includes("write-tree")) return spawnGitProcess(binary, args, options);
          hung = true;
          return spawnGitProcess(process.execPath, ["-e", hang, grandchildPid], options);
        },
      },
    });
    try {
      const failure = await service
        .createCheckpoint({ worktree: repo, threadId: "send", label: "stuck" })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "git_timeout" });
      if (!(failure instanceof GitError) || !failure.cleanup)
        throw new Error("Missing cleanup receipt");
      expect(await failure.cleanup.settled).toMatchObject({ status: "confirmed" });
      const grandchild = Number(await readFile(grandchildPid, "utf8"));
      expect(alive(grandchild)).toBe(false);
      await expect
        .poll(() => service.mutationState(repo), { timeout: 10_000 })
        .toMatchObject({ status: "available" });
      expect(await journal(repo)).toEqual([]);
      await expect(
        service.createCheckpoint({ worktree: repo, threadId: "send", label: "next" }),
      ).resolves.toMatchObject({ label: "next" });
    } finally {
      await service.close();
    }
  });

  test("a stopped daemon's lease waits for Git working in its checkout, but not for Git in another one", async () => {
    const repo = await repository();
    const elsewhere = await repository();
    const other = await heldGit(elsewhere);
    const same = await heldGit(repo);
    const lease = await leftLease(repo);
    const service = new GitService({ leaseWaitMs: 0 });
    try {
      expect(await service.mutationState(repo)).toMatchObject({ status: "quarantined" });
      await same.stop();
      // taskkill returns before Windows has removed every killed process.
      await expect
        .poll(() => service.mutationState(repo), { timeout: 5000 })
        .toMatchObject({ status: "available" });
      expect(await exists(lease)).toBe(false);
    } finally {
      await other.stop();
      await service.close();
    }
  });

  test("Git started in the checkout after its daemon was found stopped does not hold the lease", async () => {
    const repo = await repository();
    const before = await heldGit(repo);
    const lease = await leftLease(repo);
    const service = new GitService({ leaseWaitMs: 0 });
    try {
      expect(await service.mutationState(repo)).toMatchObject({ status: "quarantined" });
      const after = await heldGit(repo);
      try {
        await before.stop();
        await expect
          .poll(() => service.mutationState(repo), { timeout: 5000 })
          .toMatchObject({ status: "available" });
        expect(await exists(lease)).toBe(false);
      } finally {
        await after.stop();
      }
    } finally {
      await before.stop();
      await service.close();
    }
  });

  test("a running fsmonitor daemon does not hold a stopped daemon's lease", async (context) => {
    const repo = await repository();
    try {
      await git(repo, "fsmonitor--daemon", "start");
    } catch {
      context.skip(); // This Git for Windows has no built-in fsmonitor.
    }
    try {
      await expect
        .poll(async () => (await git(repo, "fsmonitor--daemon", "status")).toString())
        .toMatch(/watching/);
      const lease = await leftLease(repo);
      const service = new GitService({ leaseWaitMs: 0 });
      try {
        expect(await service.mutationState(repo)).toMatchObject({ status: "available" });
        expect(await exists(lease)).toBe(false);
      } finally {
        await service.close();
      }
    } finally {
      await git(repo, "fsmonitor--daemon", "stop").catch(() => undefined);
    }
  });
});
