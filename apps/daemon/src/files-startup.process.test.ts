import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { z } from "zod";
import { FilesService } from "@ace/files";
import { workspaceRuntime } from "@ace/workspace";
import { AdapterRegistry, readConfig, startDaemon } from "./index.ts";
import { accessRequest } from "./client-access.ts";

async function bounded<T>(operation: Promise<T>, milliseconds: number) {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error("Startup exceeded its budget")),
    milliseconds,
  );
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

test("a moved expired upload warms up behind the listener and cancellation retains its byte reservation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-files-startup-")));
  const workspace = join(root, "workspace");
  const home = join(root, "ace");
  await mkdir(join(workspace, "original"), { recursive: true });
  await mkdir(join(workspace, "ignored"));
  await writeFile(join(workspace, ".gitignore"), "ignored/\n");
  await promisify(execFile)("git", ["init", workspace], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  for (let batch = 0; batch < 2000; batch += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, 2000 - batch) }, (_, n) =>
        writeFile(join(workspace, "ignored", `${batch + n}.txt`), "fixture"),
      ),
    );
  const options = {
    workspace,
    dataDir: join(home, "files"),
    now: () => 0,
    id: randomUUID,
    authorize: () => true,
    maxReservedBytes: 16,
    retentionMs: 1,
  };
  const initial = await FilesService.create(options);
  const upload = z.object({ uploadId: z.string() }).parse(
    await initial.request("device", {
      op: "upload.begin",
      path: "original/file.txt",
      expected: null,
      size: 16,
    }),
  );
  await initial.close();
  await rename(join(workspace, "original"), join(workspace, "moved"));
  const runtime = workspaceRuntime();
  const filesystem = runtime.filesystem;
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const lifetime = new AbortController();
  let entered = false;
  // Gate the actual workspace traversal at its filesystem boundary.
  runtime.filesystem = {
    ...filesystem,
    async realpath(path) {
      if (path === join(workspace, "ignored") && !entered) {
        entered = true;
        reached.resolve();
        await gate.promise;
      }
      return filesystem.realpath(path);
    },
  };
  const opening = startDaemon({
    config: readConfig({
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_WORKSPACE_ROOT: workspace,
      ACE_LOG_LEVEL: "silent",
    }),
    signal: lifetime.signal,
    files: { workspaceRuntime: runtime, maxReservedBytes: 16 },
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    history: { instances: [] },
    notificationChannels: {},
  });
  let daemon: Awaited<typeof opening> | undefined;
  try {
    await reached.promise;
    daemon = await bounded(opening, 8000);
    const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
    const token = await readFile(join(home, "daemon-token"), "utf8");
    expect(await accessRequest(origin, "/v1/status", { token })).toMatchObject({
      running: true,
      services: expect.arrayContaining([{ name: "files", state: "starting" }]),
    });
    const files = daemon.files;
    if (!files) throw new Error("Files unavailable during warmup");
    expect(
      await bounded(files.request("device", { op: "stat", path: "ignored/0.txt" }), 1000),
    ).toMatchObject({ path: "ignored/0.txt", size: 7, type: "file" });
    // Cancellation occurs while the scan is held, before reaching the relocated inode.
    lifetime.abort();
    gate.resolve();
    await bounded(daemon.close(), 2000);
    await expect(readFile(join(home, "daemon-endpoint"))).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = await FilesService.create(options);
    try {
      await expect(
        reopened.request("device", {
          op: "upload.begin",
          path: "next.txt",
          expected: null,
          size: 1,
        }),
      ).rejects.toMatchObject({ code: "QUOTA" });
      // The exact old inode is still present: abort never refunds unremoved debt.
      expect(
        await readFile(join(workspace, "moved", `.ace-upload-${upload.uploadId}`)),
      ).toHaveLength(0);
      await reopened.sweep();
      const admitted = z.object({ uploadId: z.string() }).parse(
        await reopened.request("device", {
          op: "upload.begin",
          path: "next.txt",
          expected: null,
          size: 1,
        }),
      );
      expect(admitted.uploadId).not.toBe(upload.uploadId);
    } finally {
      await reopened.close();
    }
  } finally {
    lifetime.abort();
    gate.resolve();
    await (daemon ? daemon.close() : opening.then((value) => value.close())).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
