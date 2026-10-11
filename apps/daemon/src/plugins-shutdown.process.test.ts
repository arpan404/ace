import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { PluginManager, gitRuntime } from "@ace/plugins";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { DeviceId } from "@ace/protocol";
import { startDaemon, readConfig } from "./index.ts";
import { Client } from "./socket-test-support.ts";
import { acquireLock } from "./local-files.ts";

test.each(["within deadline", "beyond deadline"] as const)(
  "daemon shutdown %s preserves a socket preparation still draining its Git cleanup",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ace-plugin-shutdown-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(
      join(repo, "marketplace.json"),
      JSON.stringify({ name: "test", plugins: [{ name: "sample", source: "." }] }),
    );
    await writeFile(
      join(repo, "ace-plugin.json"),
      JSON.stringify({ schemaVersion: 1, name: "sample", version: "1" }),
    );
    const git = (args: string[]) => promisify(execFile)("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<() => void>();
    const overallDeadline = Promise.withResolvers<() => void>();
    let settle: (() => Promise<void>) | undefined;
    let stopWatching: (() => void) | undefined;
    const original = PluginManager.openIndex;
    const runtime = gitRuntime();
    const spy = vi.spyOn(PluginManager, "openIndex").mockImplementation((options) =>
      original({
        ...options,
        git: {
          ...runtime,
          async release(directory) {
            await runtime.release(directory);
            entered.resolve();
            await release.promise;
          },
        },
      }),
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let client: Client | undefined;
    try {
      const home = join(root, "daemon");
      daemon = await startDaemon({
        config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
        modelInstances: [],
        history: { instances: [] },
        startup: {
          schedule(name, expire, milliseconds) {
            if (name === "plugins" && milliseconds === 6000) {
              cleanupStarted.resolve(expire);
              if (mode === "beyond deadline") return () => {};
            }
            if (name === "shutdown" && mode === "beyond deadline") {
              overallDeadline.resolve(expire);
              return () => {};
            }
            const timer = setTimeout(expire, milliseconds);
            return () => clearTimeout(timer);
          },
        },
      });
      const unlocked = Promise.withResolvers<void>();
      const lockPath = join(home, "daemon-lock");
      const watcher = watch(home, () => {
        if (!existsSync(lockPath)) unlocked.resolve();
      });
      stopWatching = () => watcher.close();
      settle = async () => {
        release.resolve();
        if (!existsSync(lockPath)) unlocked.resolve();
        await unlocked.promise;
      };
      const token = (await readFile(daemon.tokenPath, "utf8")).trim();
      client = new Client(daemon.url);
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("plugins-shutdown"),
        token,
      });
      expect(await client.next()).toMatchObject({ type: "welcome" });
      client.send({
        type: "pluginRequest",
        requestId: "prepare",
        request: { type: "plugins.prepare", repository: repo, ref: "main", name: "sample" },
      });
      await entered.promise;
      const closing = daemon.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      const expireCleanup = await cleanupStarted.promise;
      await writeFile(join(root, "cleanup-observed"), "checkpoint");
      if (mode === "beyond deadline") {
        expireCleanup();
        (await overallDeadline.promise)();
        expect(await closing).toMatchObject({ message: "Daemon shutdown deadline exceeded" });
        await expect(readFile(join(home, "daemon-endpoint"))).rejects.toThrow("ENOENT");
        expect(() => acquireLock(home)).toThrow("Another daemon owns it");
        await settle();
      } else {
        release.resolve();
        expect(await closing).toBeUndefined();
      }
      spy.mockRestore();
      const manager = await PluginManager.open({
        root: join(home, "plugins"),
        now: () => 1,
        id: () => "unused",
      });
      try {
        const pending = manager.pending();
        expect(pending).toHaveLength(1);
        const review = pending[0];
        if (!review) throw new Error("Missing durable review");
        await access(join(home, "plugins", "staging", review.id, "ace-plugin.json"));
        expect(await manager.accept(review)).toMatchObject({ hash: review.hash });
      } finally {
        manager.close();
      }
    } finally {
      release.resolve();
      await client?.close();
      await daemon?.close().catch((error: unknown) => {
        if (
          mode !== "beyond deadline" ||
          !(error instanceof Error) ||
          error.message !== "Daemon shutdown deadline exceeded"
        )
          throw error;
      });
      await settle?.();
      stopWatching?.();
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
