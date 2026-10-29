import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, spawn, type ChildProcess, type Serializable } from "node:child_process";
import { expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";
import { UsageScanner } from "./usage-scanner.ts";

const put = async (root: string, path: string, contents: string) => {
  const parts = path.split("/");
  parts.pop();
  await mkdir(join(root, ...parts), { recursive: true });
  await writeFile(join(root, path), contents);
};
const bytes = (usage: Awaited<ReturnType<UsageScanner["scan"]>>, kind: string) =>
  usage.categories.find((entry) => entry.kind === kind)?.bytes;

function trackingRuntime(script?: string) {
  const workers: ChildProcess[] = [];
  const spawnWorker = (entry: URL) => {
    const worker =
      script === undefined
        ? fork(entry, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] })
        : spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    workers.push(worker);
    return worker;
  };
  return { spawn: spawnWorker, workers };
}

test("counts every category beyond cleanup's candidate page without inspecting Git or following links", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime();
  const scanner = new UsageScanner(f.root, { spawn: tracking.spawn });
  const outside = await mkdtemp(join(tmpdir(), "usage-outside-"));
  try {
    for (let i = 0; i < 270; i++) f.thread(`usage-${String(i).padStart(4, "0")}`);
    // Each thread seeds its created event and a long-history header, with no item/blob rows.
    // The header is 27 bytes: ten-byte id, ordinal "0", and sixteen-byte done status.
    // Read event payloads directly, independently of either transcript helper.
    const expectedTranscript =
      Number(
        f.store.statement("SELECT SUM(octet_length(payload)) AS bytes FROM events").get()?.bytes,
      ) +
      270 * 27;
    expect(expectedTranscript).toBeGreaterThan(0);
    await put(f.root, "logs/current", "logs");
    await put(f.root, "support/artifacts/diagnostics", "support");
    await put(f.root, "artifacts/image", "image");
    await put(f.root, "browser/session/screenshot", "browser");
    await put(f.root, "browser/profiles/private", "excluded profile");
    await put(f.root, "browser/ephemeral-session/private", "excluded ephemeral");
    await put(f.root, "cache/entry", "cache");
    await put(f.root, "caches/entry", "caches");
    await put(f.root, "builtin-skill-sessions/session-ABC123/asset", "skill");
    await put(f.root, "context/blobs/blob", "attachment");
    await link(join(f.root, "context/blobs/blob"), join(f.root, "context/blobs/blob.png"));
    await put(f.root, "context/uploads/pending", "pending");
    await put(f.root, "uploads/wrong-root", "must not count");
    await put(outside, "external", "external private bytes".repeat(100));
    // No .git file and no repository: usage still measures registered bytes.
    await put(f.root, "worktrees/topic/file", "worktree");
    const parent = await lstat(join(f.root, "worktrees"));
    const tree = await lstat(join(f.root, "worktrees/topic"));
    const path = join(f.root, "worktrees/topic");
    f.store.statement("INSERT INTO managed_worktrees VALUES(?,?,0)").run(
      path,
      JSON.stringify({
        path,
        parent_dev: parent.dev,
        parent_ino: parent.ino,
        tree_dev: tree.dev,
        tree_ino: tree.ino,
      }),
    );
    f.store
      .statement("INSERT INTO storage_worktree_backups VALUES(?,?)")
      .run(path, JSON.stringify({ path, state: "failed", updatedAt: 123, error: "test_failure" }));
    let linkBytes = 0;
    if (process.platform !== "win32") {
      const target = join(outside, "external");
      await symlink(target, join(f.root, "artifacts/link"));
      linkBytes = (await lstat(join(f.root, "artifacts/link"))).size;
    }
    // Read-only connection never migrates or writes application tables.
    const before = f.store.statement("PRAGMA data_version").get();
    const started = Date.now();
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 2);
    const usage = await scanner.scan().finally(() => clearInterval(heartbeat));
    expect(usage.complete).toBe(true);
    expect(bytes(usage, "logs")).toBe(11);
    expect(bytes(usage, "artifacts")).toBe(12 + linkBytes);
    expect(bytes(usage, "caches")).toBe(16);
    expect(bytes(usage, "attachments")).toBe(17);
    expect(bytes(usage, "worktrees")).toBe(8);
    expect(bytes(usage, "threads")).toBe(expectedTranscript);
    expect(usage.categories.find((entry) => entry.kind === "threads")?.items).toBe(270);
    expect(usage.backups).toEqual([
      { path, state: "failed", updatedAt: 123, error: "test_failure" },
    ]);
    expect(usage.measuredAt).toBeGreaterThanOrEqual(started);
    expect(usage.databaseBytes).toBeGreaterThan(0);
    expect(f.store.statement("PRAGMA data_version").get()).toEqual(before);
    expect(ticks).toBeGreaterThan(2);
    expect(
      tracking.workers.map((worker) => worker.exitCode !== null || worker.signalCode !== null),
    ).toEqual([true]);
    await scanner.scan();
    expect(
      tracking.workers.map((worker) => worker.exitCode !== null || worker.signalCode !== null),
    ).toEqual([true, true]);
    expect(await readFile(join(outside, "external"), "utf8")).toBe(
      "external private bytes".repeat(100),
    );
  } finally {
    await scanner.close();
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("reports incomplete sizes for entry and depth caps and unreadable directories", async () => {
  const f = await storageFixture();
  try {
    await put(f.root, "logs/deep/inside/file", "data");
    const depth = new UsageScanner(f.root, { limits: { maxDepth: 1 } });
    try {
      expect((await depth.scan()).complete).toBe(false);
    } finally {
      await depth.close();
    }
    const entries = new UsageScanner(f.root, { limits: { maxEntries: 1 } });
    try {
      expect((await entries.scan()).complete).toBe(false);
    } finally {
      await entries.close();
    }
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(join(f.root, "logs/deep"), 0);
      const unreadable = new UsageScanner(f.root);
      try {
        expect((await unreadable.scan()).complete).toBe(false);
      } finally {
        await unreadable.close();
        await chmod(join(f.root, "logs/deep"), 0o700);
      }
    }
  } finally {
    await f.close();
  }
});

test("refuses managed records outside its root and symlinked category directories", async () => {
  const f = await storageFixture();
  const scanner = new UsageScanner(f.root);
  const outside = await mkdtemp(join(tmpdir(), "usage-escape-"));
  try {
    await put(outside, "file", "private".repeat(1000));
    const path = outside;
    f.store
      .statement("INSERT INTO managed_worktrees VALUES(?,?,0)")
      .run(path, JSON.stringify({ path, parent_dev: 0, parent_ino: 0, tree_dev: 0, tree_ino: 0 }));
    await symlink(
      outside,
      join(f.root, "cache"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const usage = await scanner.scan();
    expect(usage.complete).toBe(false);
    expect(bytes(usage, "worktrees")).toBe(0);
    expect(bytes(usage, "caches")).toBeLessThan(7000);
  } finally {
    await scanner.close();
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("aborts and closes an active isolate, rejecting concurrent and later scans", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime("setInterval(() => {}, 1000)");
  const scanner = new UsageScanner(f.root, { spawn: tracking.spawn });
  try {
    const controller = new AbortController();
    const scanning = scanner.scan(controller.signal);
    const rejection = expect(scanning).rejects.toThrow("storage_usage_cancelled");
    await expect(scanner.scan()).rejects.toThrow("storage_busy");
    controller.abort();
    await rejection;
    expect(tracking.workers[0]?.signalCode).toBe("SIGKILL");
    const pending = scanner.scan();
    const cancelled = expect(pending).rejects.toThrow("storage_usage_cancelled");
    const started = performance.now();
    await scanner.close();
    await cancelled;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(
      tracking.workers.every((worker) => worker.exitCode !== null || worker.signalCode !== null),
    ).toBe(true);
    await expect(scanner.scan()).rejects.toThrow("storage_closed");
  } finally {
    await scanner.close();
    await f.close();
  }
});

test("worker crashes reject the scan and a later scan gets a fresh worker", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime("throw new Error('crash')");
  const scanner = new UsageScanner(f.root, { spawn: tracking.spawn });
  try {
    await expect(scanner.scan()).rejects.toThrow("storage_usage_worker_failed");
    await expect(scanner.scan()).rejects.toThrow("storage_usage_worker_failed");
    expect(
      tracking.workers.map((worker) => worker.exitCode !== null || worker.signalCode !== null),
    ).toEqual([true, true]);
  } finally {
    await scanner.close();
    await f.close();
  }
});

test("measures managed worktrees past the cleanup page without visiting unregistered trees", async () => {
  const f = await storageFixture();
  const scanner = new UsageScanner(f.root);
  try {
    await mkdir(join(f.root, "worktrees"));
    const parent = await lstat(join(f.root, "worktrees"));
    for (let index = 0; index < 270; index++) {
      const path = join(f.root, "worktrees", `tree-${String(index).padStart(4, "0")}`);
      await mkdir(path);
      await writeFile(join(path, "file"), "abc");
      const tree = await lstat(path);
      f.store.statement("INSERT INTO managed_worktrees VALUES(?,?,0)").run(
        path,
        JSON.stringify({
          path,
          parent_dev: parent.dev,
          parent_ino: parent.ino,
          tree_dev: tree.dev,
          tree_ino: tree.ino,
        }),
      );
    }
    await put(f.root, "worktrees/unregistered/file", "unregistered".repeat(100));
    const usage = await scanner.scan();
    expect(usage.complete).toBe(true);
    expect(usage.categories.find((entry) => entry.kind === "worktrees")).toEqual({
      kind: "worktrees",
      bytes: 810,
      items: 270,
    });
  } finally {
    await scanner.close();
    await f.close();
  }
});

test("failed starts and malformed replies reject without leaving a process behind", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime(
    "process.on('message', () => process.send({unexpected: true})); setInterval(() => {}, 1000)",
  );
  const malformed = new UsageScanner(f.root, { spawn: tracking.spawn });
  const failed = new UsageScanner(f.root, {
    spawn: () =>
      spawn(join(f.root, "missing-executable"), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
  });
  try {
    await expect(malformed.scan()).rejects.toThrow("storage_usage_failed");
    expect(tracking.workers[0]?.signalCode).toBe("SIGKILL");
    await expect(failed.scan()).rejects.toThrow("storage_usage_worker_failed");
  } finally {
    await malformed.close();
    await failed.close();
    await f.close();
  }
});

test("a stalled worker reaches its deadline and is reaped before the scan rejects", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime("setInterval(() => {}, 1000)");
  const scanner = new UsageScanner(f.root, { spawn: tracking.spawn, limits: { maxMs: 1 } });
  try {
    const started = performance.now();
    await expect(scanner.scan()).rejects.toThrow("storage_usage_timeout");
    expect(performance.now() - started).toBeLessThan(7000);
    expect(tracking.workers[0]?.signalCode).toBe("SIGKILL");
  } finally {
    await scanner.close();
    await f.close();
  }
});

test("a missing or corrupt database keeps measured files and reports incomplete usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-missing-db-"));
  const scanner = new UsageScanner(root);
  try {
    await put(root, "logs/file", "known bytes");
    for (const state of ["missing", "corrupt"]) {
      if (state === "corrupt") await writeFile(join(root, "events.sqlite"), "not a SQLite file");
      const usage = await scanner.scan();
      expect(usage.complete).toBe(false);
      expect(bytes(usage, "logs")).toBe(11);
      expect(bytes(usage, "threads")).toBe(0);
    }
  } finally {
    await scanner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an IPC close race during cancellation still rejects and reaps the worker", async () => {
  const f = await storageFixture();
  const tracking = trackingRuntime("setInterval(() => {}, 1000)");
  const controller = new AbortController();
  const scanner = new UsageScanner(f.root, {
    spawn(entry) {
      const worker = tracking.spawn(entry);
      const send = worker.send.bind(worker);
      Object.defineProperty(worker, "send", {
        value(message: Serializable, callback: (error: Error | null) => void) {
          if (
            typeof message === "object" &&
            message !== null &&
            "op" in message &&
            message.op === "cancel"
          ) {
            worker.kill("SIGKILL");
            throw new Error("IPC channel closed during cancellation");
          }
          return send(message, callback);
        },
      });
      return worker;
    },
  });
  try {
    const scanning = scanner.scan(controller.signal);
    const rejected = expect(scanning).rejects.toThrow("storage_usage_cancelled");
    expect(() => controller.abort()).not.toThrow();
    await rejected;
    expect(tracking.workers[0]?.signalCode).toBe("SIGKILL");
  } finally {
    await scanner.close();
    await f.close();
  }
});

function withheldExitWorker() {
  const tracking = trackingRuntime(
    "process.on('message', () => process.send({unexpected: true})); setInterval(() => {}, 1000)",
  );
  let notifyExit: (() => void) | undefined;
  return {
    workers: tracking.workers,
    spawn(entry: URL) {
      const worker = tracking.spawn(entry);
      if (tracking.workers.length === 1) {
        const emit = worker.emit.bind(worker);
        let withholding = true;
        Object.defineProperty(worker, "emit", {
          value(event: string | symbol, ...args: unknown[]) {
            if (withholding && (event === "exit" || event === "close")) return true;
            return emit(event, ...args);
          },
        });
        notifyExit = () => {
          withholding = false;
          worker.emit("exit", null, "SIGKILL");
        };
      }
      return worker;
    },
    notifyExit() {
      notifyExit?.();
    },
  };
}

test("a missing exit notification bounds scan cleanup and blocks replacements until late exit", async () => {
  const tracking = withheldExitWorker();
  const scanner = new UsageScanner("unused", { spawn: tracking.spawn });
  try {
    await scanner.waitForIdle();
    const started = performance.now();
    const scanning = scanner.scan();
    let idle = false;
    const actualExit = scanner.waitForIdle().then(() => {
      idle = true;
    });
    await expect(scanning).rejects.toThrow("storage_usage_cleanup_timeout");
    expect(idle).toBe(false);
    expect(performance.now() - started).toBeLessThan(4000);
    await expect(scanner.scan()).rejects.toThrow("storage_busy");
    expect(tracking.workers).toHaveLength(1);
    tracking.notifyExit();
    tracking.notifyExit();
    await actualExit;
    expect(idle).toBe(true);
    await expect(scanner.scan()).rejects.toThrow("storage_usage_failed");
    await scanner.waitForIdle();
    expect(tracking.workers).toHaveLength(2);
  } finally {
    tracking.notifyExit();
    await scanner.close();
  }
});

test("close reports the cleanup deadline when a killed child never reports exit", async () => {
  const tracking = withheldExitWorker();
  const scanner = new UsageScanner("unused", { spawn: tracking.spawn });
  try {
    const scanning = scanner.scan();
    const scanRejected = expect(scanning).rejects.toThrow("storage_usage_cleanup_timeout");
    const started = performance.now();
    await expect(scanner.close()).rejects.toThrow("storage_usage_cleanup_timeout");
    await scanRejected;
    expect(performance.now() - started).toBeLessThan(4500);
    await expect(scanner.close()).rejects.toThrow("storage_usage_cleanup_timeout");
    tracking.notifyExit();
    tracking.notifyExit();
    await scanner.close();
  } finally {
    tracking.notifyExit();
    await scanner.close();
  }
});
