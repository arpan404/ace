import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { Command } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
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
    // Real Git and its fixed HTTP helper share this exclusive fixture process group.
    // No repository-controlled helper, hook or transport can escape it.
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export type FetchFailure = "timeout" | "cancellation" | "stream failure";
export async function transferHarness() {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
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
    const id = await h.create();
    let engine = h.engine,
      store = h.store,
      sequence = 0;
    return {
      home: h.home,
      clock: h.clock,
      get engine() {
        return engine;
      },
      nextRemote() {
        return `transfer-${++sequence}`;
      },
      followUp() {
        const command = Command.parse({
          id: `admission-${++sequence}`,
          deviceId: "device",
          payload: {
            type: "thread.send",
            threadId: id,
            input: [{ type: "text", text: "Resume after fetch" }],
          },
        });
        return store.recordCommand(command.id, command.deviceId, () =>
          engine.handler.handle(command, store),
        );
      },
      state() {
        return store.getThread(id)?.status.state;
      },
      async restart() {
        await engine.close();
        await store.close();
        store = new Store(h.path);
        engine = new Engine(store, { registry: h.registry, clock: h.clock });
        await engine.flush();
      },
      async close() {
        if (engine !== h.engine) await engine.close();
        if (store !== h.store) await store.close();
        await h.close();
      },
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}

export async function stalledFetch(h: Awaited<ReturnType<typeof transferHarness>>) {
  const requested = Promise.withResolvers<void>();
  const containment = Promise.withResolvers<CleanupResult>();
  let firstRequest = true;
  const server = createServer((_, response) => {
    if (firstRequest) {
      firstRequest = false;
      requested.resolve();
      return;
    }
    // If admission breaks, a retry must fail promptly rather than hang the regression.
    response.writeHead(404);
    response.end("Unexpected second transfer");
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
        if (args.includes("fetch") && transport === undefined) {
          transport = child;
          exited = once(child, "exit");
        }
        return child;
      },
      scheduleTimeout: h.clock.setTimer,
      cleanupSupervisor: {
        // Inject delayed containment while keeping the actual HTTP Git process alive.
        stop: () => ({ settled: containment.promise }),
        recover: async () => ({ status: "unconfirmed", reason: "No recovery in this fixture" }),
      },
    },
  });
  const remote = h.nextRemote();
  const options = {
    repo: h.home,
    remote,
    branch: "main",
    timeoutMs: 12_345,
    signal: controller.signal,
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
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
    })());
  try {
    await git(h.home, "remote", "add", remote, `http://127.0.0.1:${address.port}/repo.git`);
    const operation = service.fetchBranch(options).catch((error: unknown) => error);
    await Promise.race([
      requested.promise,
      operation.then(() => {
        throw new Error("Fetch ended before reaching the remote");
      }),
    ]);
    const child = transport,
      pid = child?.pid;
    if (!child || pid === undefined) throw new Error("Missing live Git child");
    return {
      containment,
      retry: () => service.fetchBranch({ ...options, signal: undefined }),
      checkAlive() {
        process.kill(pid, 0);
      },
      async fail(failure: FetchFailure): Promise<GitError> {
        if (failure === "timeout") h.clock.advance(h.clock.now() + 12_345);
        else if (failure === "cancellation") controller.abort();
        else
          child.stdout.destroy(Object.assign(new Error("Fixture stream failed"), { code: "EIO" }));
        const error = await operation;
        if (!(error instanceof GitError)) throw new Error("Expected Git failure");
        return error;
      },
      async stop() {
        stopTransport(child);
        await exited;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
