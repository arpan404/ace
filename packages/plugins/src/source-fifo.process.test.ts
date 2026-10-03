import { afterEach, expect, test } from "vitest";
import { spawn, execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

// The process boundary lets teardown terminate a deliberately broken blocking open.
// No writer, sleeps, clock assertions or timeout budgets synchronize this regression.
test("a warmed source request rejects a replacement FIFO without requiring any writer", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const install = await f.manager.accept(await f.prepare());
  const path = "skills/review/SKILL.md";
  const physical = join(f.managerRoot, "versions", install.hash, path);
  const response = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("result"), error: z.string().nullable() }),
  ]);
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string | null>();
  const source = new URL("./index.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { PluginManager, PluginService } from ${JSON.stringify(source)};
    const manager = await PluginManager.open({ root: ${JSON.stringify(f.managerRoot)}, now: () => 123, id: () => "reader" });
    const service = new PluginService(manager);
    await service.handle({ type: "plugins.catalog", offset: 0, limit: 50 });
    process.send({ type: "ready" });
    process.once("message", async () => {
      let error = null;
      try { await service.handle({ type: "plugins.source", name: "sample", path: ${JSON.stringify(path)}, offset: 0, limit: 4 }); }
      catch (cause) { error = cause instanceof Error ? cause.message : "unknown"; }
      manager.close();
      process.send({ type: "result", error }, () => process.disconnect());
    });
  `,
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.on("error", (error) => {
    ready.reject(error);
    result.reject(error);
  });
  child.on("message", (value: unknown) => {
    const message = response.parse(value);
    if (message.type === "ready") ready.resolve();
    else result.resolve(message.error);
  });
  child.once("exit", (code) => {
    if (code !== 0) {
      ready.reject(new Error("Source reader exited"));
      result.reject(new Error("Source reader exited"));
    }
  });
  // Prevent teardown errors becoming unhandled rejections after a failed regression.
  void ready.promise.catch(() => {});
  void result.promise.catch(() => {});
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await ready.promise;
  await unlink(physical);
  await promisify(execFile)("mkfifo", [physical]);
  if (!child.send) throw new Error("IPC channel missing");
  child.send("read");
  expect(await result.promise).toBe("Special file forbidden");
  await exited;
});
