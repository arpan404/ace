import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess, type GitProcessRuntime } from "@ace/git";
import type { CleanupResult } from "@ace/provider-kit/cleanup";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  await execute("git", args, { cwd, encoding: "utf8" });
}
function stopTransport(child: ReturnType<GitProcessRuntime["spawn"]>): void {
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  if (child.pid === undefined) return;
  try {
    // The fixture uses real Git and its fixed HTTP helper, in one exclusive process group.
    // No repository-controlled helper, hook or transport can escape the group.
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

test.each([
  { failure: "timeout", code: "git_timeout" },
  { failure: "cancellation", code: "git_cancelled" },
  { failure: "stream failure", code: "filesystem_error" },
])(
  "a fetch $failure keeps provider admission fenced until live-child cleanup is confirmed",
  async ({ failure, code }) => {
    const frames = scriptFrames();
    const h = await harness(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        { on: "send", frames: [frames.frame(start)] },
      ],
      frames,
    );
    const requested = Promise.withResolvers<void>();
    const containment = Promise.withResolvers<CleanupResult>();
    const server = createServer(() => {
      // Keep the actual HTTP transport waiting after it reaches the remote.
      requested.resolve();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    let transport: ReturnType<GitProcessRuntime["spawn"]> | undefined;
    let exited: Promise<unknown> | undefined;
    const controller = new AbortController();
    const service = new GitService({
      transportProtocols: ["http"],
      credentialHelperLookup: async () => [],
      withRepositoryTransfer: (repository, operation) =>
        h.engine.withRepositoryTransfer(repository, operation),
      processRuntime: {
        spawn(binary, args, options) {
          const child = spawnGitProcess(binary, args, options);
          if (args.includes("fetch")) {
            transport = child;
            exited = once(child, "exit");
          }
          return child;
        },
        scheduleTimeout: h.clock.setTimer,
        cleanupSupervisor: {
          // Inject delayed containment at the supervisor boundary. Failure must return while
          // the real Git child remains alive, without pretending its exit proves containment.
          stop: () => ({ settled: containment.promise }),
          recover: async () => ({ status: "unconfirmed", reason: "No recovery in this fixture" }),
        },
      },
    });
    try {
      await git(h.home, "init", "-b", "main");
      await git(
        h.home,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      );
      await git(h.home, "remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`);
      const id = await h.create();
      const operation = service
        .fetchBranch({
          repo: h.home,
          remote: "origin",
          branch: "main",
          timeoutMs: 12_345,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      await Promise.race([
        requested.promise,
        operation.then(() => {
          throw new Error("Fetch ended before reaching the remote");
        }),
      ]);
      const child = transport;
      const pid = child?.pid;
      if (!child || pid === undefined) throw new Error("Missing live Git child");
      if (failure === "timeout") h.clock.advance(h.clock.now() + 12_345);
      else if (failure === "cancellation") controller.abort();
      else child.stdout.destroy(Object.assign(new Error("Fixture stream failed"), { code: "EIO" }));
      const error = await operation;
      expect(error).toMatchObject({ code });
      expect(() => process.kill(pid, 0)).not.toThrow();
      const followUp = () =>
        h.command({
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "Resume after fetch" }],
        });
      expect(followUp()).toMatchObject({ ok: false, error: "workspace_change_in_progress" });
      await h.engine.flush();
      expect(h.store.getThread(id)?.status.state).toBe("done");
      stopTransport(child);
      await exited;
      // Even actual exit must not release admission before the supervisor confirms containment.
      expect(followUp()).toMatchObject({ ok: false, error: "workspace_change_in_progress" });
      containment.resolve({
        status: "confirmed",
        evidence: "Exclusive fixture transport group contained",
      });
      if (!(error instanceof GitError) || !error.cleanup)
        throw new Error("Missing transfer cleanup receipt");
      await error.cleanup.settled;
      expect(followUp()).toMatchObject({ ok: true });
      await h.engine.flush();
      expect(h.store.getThread(id)?.status.state).toBe("working");
    } finally {
      controller.abort();
      if (transport) stopTransport(transport);
      await exited;
      containment.resolve({
        status: "unconfirmed",
        reason: "Fixture teardown without confirmation",
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await service.close();
      await h.close();
    }
  },
);
