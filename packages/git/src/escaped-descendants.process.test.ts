import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import type { CleanupResult, MutationLease } from "@ace/provider-kit/cleanup";
import { connect } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess } from "./index.ts";
import { execute, git, repository, scratch } from "./test-repo.ts";

async function request(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(command));
    let output = "";
    socket.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      socket.destroy();
      resolve(output);
    });
    socket.setTimeout(PROCESS_TEST_TIMEOUT, () =>
      socket.destroy(new Error("Fixture socket timed out")),
    );
  });
}
async function stopped(pid: number): Promise<void> {
  // The fixture forks exactly one known writer and no further processes. Inspect
  // its kernel state after the control endpoint has closed, before issuing proof.
  for (let attempt = 0; attempt < 256; attempt++) {
    const state = await execute("ps", ["-o", "stat=", "-p", String(pid)], {
      timeout: PROCESS_TEST_TIMEOUT,
    }).catch((error: unknown) => {
      if (!z.object({ code: z.literal(1) }).safeParse(error).success) throw error;
      return { stdout: "" };
    });
    if (!state.stdout.trim() || /^[Z?]/.test(state.stdout.trim())) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Fixture writer is still running");
}

const Ready = z.object({ pid: z.number().int().positive(), port: z.number().int().positive() });

test.each([
  ["receipt", "deadline"],
  ["restart", "deadline"],
  ["receipt", "shutdown"],
] as const)(
  "escaped checkout writers deny root and child mutation until confirmed cleanup via %s after %s",
  async (recovery, cancellation) => {
    const root = await repository({ "child/tracked.txt": "target\n" });
    const childRoot = join(root, "child");
    await git(childRoot, "init", "--initial-branch=main");
    await git(childRoot, "config", "user.name", "Test");
    await git(childRoot, "config", "user.email", "test@example.invalid");
    await git(childRoot, "add", "--all");
    await git(childRoot, "commit", "-m", "Child");
    const baseline = new GitService();
    const target = await baseline.createCheckpoint({
      worktree: root,
      threadId: "escaped",
      label: "target",
    });
    await writeFile(join(childRoot, "tracked.txt"), "before\n");
    const directory = await scratch();
    const writer = join(directory, "writer.cjs");
    const parent = join(directory, "parent.cjs");
    await writeFile(
      writer,
      `
      const fs = require('node:fs'), net = require('node:net');
      process.stdout.on('error',()=>{}); process.stderr.on('error',()=>{});
      const server = net.createServer(socket => socket.once('data', command => {
        if (command.toString() === 'write') { fs.writeFileSync(process.argv[2], 'escaped\\n'); socket.end('written'); }
        else { socket.end('stopped'); server.close(()=>process.exit(0)); }
      }));
      server.listen(0,'127.0.0.1',()=>process.stderr.write(JSON.stringify({pid:process.pid,port:server.address().port})+'\\n'));
    `,
    );
    await writeFile(
      parent,
      `
      require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}, ${JSON.stringify(join(childRoot, "tracked.txt"))}],
        { detached:true, stdio:['ignore',process.stdout,process.stderr] });
      setInterval(()=>{},1000);
    `,
    );
    const ready = Promise.withResolvers<z.infer<typeof Ready>>();
    const cleanup = Promise.withResolvers<CleanupResult>();
    const deadlines = new Set<() => void>();
    const identities = new Set<string>();
    let intercept = true;
    const service = new GitService({
      timeoutMs: 1234,
      processRuntime: {
        spawn: (binary, args, options) => {
          if (!intercept || options.cwd !== childRoot || !args.includes("--reset"))
            return spawnGitProcess(binary, args, options);
          intercept = false;
          const process = spawnGitProcess(globalThis.process.execPath, [parent], options);
          let stderr = "";
          process.stderr.on("data", (bytes: Buffer) => {
            stderr += bytes.toString();
            if (stderr.includes("\n")) ready.resolve(Ready.parse(JSON.parse(stderr.trim())));
          });
          process.once("error", ready.reject);
          return process;
        },
        scheduleTimeout: (callback) => {
          deadlines.add(callback);
          return () => {
            deadlines.delete(callback);
          };
        },
        cleanupSupervisor: {
          stop: (process, leases) => {
            for (const lease of leases) identities.add(lease.id);
            process.kill("SIGKILL");
            return { settled: cleanup.promise };
          },
          recover: async () => ({ status: "unconfirmed", reason: "Writer still owns the fixture" }),
        },
      },
    });
    const restore = service
      .restoreCheckpoint({ worktree: root, checkpoint: target.id })
      .catch((error: unknown) => {
        if (!(error instanceof GitError)) throw error;
        return error;
      });
    let pids: z.infer<typeof Ready> | undefined;
    try {
      pids = await Promise.race([
        ready.promise,
        restore.then(() => {
          throw new Error("Restore ended before the checkout gate");
        }),
      ]);
      // Start competing public mutations before cancellation, while checkout owns both roots.
      const queued = Promise.allSettled(
        [root, childRoot].map((worktree) =>
          baseline.createCheckpoint({ worktree, threadId: "competing", label: "must reject" }),
        ),
      );
      if (cancellation === "shutdown") await service.close();
      else for (const expire of Array.from(deadlines)) expire();
      const failure = await restore;
      expect(failure).toMatchObject({
        code: cancellation === "shutdown" ? "git_closed" : "git_timeout",
        details: { safetyCheckpointId: expect.any(String) },
      });
      if (!(failure instanceof GitError) || !failure.cleanup)
        throw new Error("Missing supervised cleanup receipt");
      expect(await request(pids.port, "write")).toBe("written");
      expect(await readFile(join(childRoot, "tracked.txt"), "utf8")).toBe("escaped\n");
      for (const outcome of await queued)
        expect(outcome).toMatchObject({ status: "rejected", reason: { code: "git_quarantined" } });
      for (const worktree of [root, childRoot]) {
        expect(await service.mutationState(worktree)).toMatchObject({ status: "quarantined" });
        await expect(
          baseline.createCheckpoint({ worktree, threadId: "blocked", label: "blocked" }),
        ).rejects.toMatchObject({ code: "git_quarantined" });
      }
      expect(await service.recoverCleanup(root)).toMatchObject({ status: "quarantined" });
      await service.close();
      // A fresh OS process has none of this module's live registries. Pipe closure,
      // parent exit and service shutdown must not turn its disk intents into permission.
      const entry = pathToFileURL(new URL("./index.ts", import.meta.url).pathname).href;
      const restarted = await execute(
        globalThis.process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        const {GitService}=await import(${JSON.stringify(entry)});
        const git=new GitService();
        const state=await git.mutationState(${JSON.stringify(root)});
        const code=await git.createCheckpoint({worktree:${JSON.stringify(childRoot)},threadId:'restart',label:'blocked'}).then(()=>'unexpected',error=>error.code);
        process.stdout.write(JSON.stringify({state:state.status,code}));await git.close();
      `,
        ],
        { timeout: PROCESS_TEST_TIMEOUT },
      );
      expect(JSON.parse(restarted.stdout)).toEqual({
        state: "quarantined",
        code: "git_quarantined",
      });
      expect(await request(pids.port, "stop")).toBe("stopped");
      await stopped(pids.pid);
      if (recovery === "receipt") {
        cleanup.resolve({
          status: "confirmed",
          evidence:
            "Exclusive fixture contains one writer; endpoint closed and kernel confirms termination",
        });
        expect(await failure.cleanup.settled).toMatchObject({ status: "confirmed" });
      } else {
        cleanup.resolve({ status: "unconfirmed", reason: "Original supervisor shut down" });
        await failure.cleanup.settled;
        const partial = new GitService({
          processRuntime: {
            cleanupSupervisor: {
              stop: () => {
                throw new Error("No process during reconciliation");
              },
              recover: async (lease) =>
                lease.root === root
                  ? { status: "confirmed", evidence: "Root fixture processes stopped" }
                  : {
                      status: "unconfirmed",
                      reason: "Child containment journal has not reconciled",
                    },
            },
          },
        });
        expect(await partial.recoverCleanup(root)).toMatchObject({ status: "quarantined" });
        await expect(
          partial.createCheckpoint({ worktree: root, threadId: "partial", label: "must reject" }),
        ).rejects.toMatchObject({ code: "git_quarantined" });
        await partial.close();
        const restartedService = new GitService({
          processRuntime: {
            cleanupSupervisor: {
              stop: () => {
                throw new Error("No processes launched during recovery");
              },
              recover: async (lease: MutationLease) =>
                identities.has(lease.id)
                  ? {
                      status: "confirmed",
                      evidence:
                        "Durable fixture identities reconciled after exclusive writer termination",
                    }
                  : { status: "unconfirmed", reason: "Unknown ownership identity" },
            },
          },
        });
        expect(await restartedService.recoverCleanup(root)).toMatchObject({
          status: "available",
          leases: [],
        });
        await restartedService.close();
      }
      for (const worktree of [root, childRoot]) {
        expect(await baseline.mutationState(worktree)).toEqual({ status: "available", leases: [] });
        expect(
          await baseline.createCheckpoint({
            worktree,
            threadId: "recovered",
            label: "after cleanup",
          }),
        ).toMatchObject({ threadId: "recovered", sequence: 1 });
      }
    } finally {
      if (pids) {
        try {
          globalThis.process.kill(pids.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      cleanup.resolve({ status: "unconfirmed", reason: "Fixture teardown" });
      await service.close();
      await baseline.close();
      await restore;
    }
  },
);
