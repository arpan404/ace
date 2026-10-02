import { createServer, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { PluginManager, gitRuntime } from "./index.ts";
import { nodeBinary } from "@ace/provider-kit/testing";
import { fixture } from "./test-support.ts";

test.each(["overflow", "timeout", "exit"] as const)(
  "Git %s terminates descendants that retain stderr before completing",
  async (mode) => {
    const f = await fixture();
    let manager: PluginManager | undefined;
    let connection: Socket | undefined;
    let pid: number | undefined;
    const disconnected = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      connection = socket;
      socket.once("close", () => disconnected.resolve());
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const pidFile = join(f.root, "descendant-pid");
      const descendant = join(f.root, "descendant.cjs");
      await writeFile(
        descendant,
        `const socket = require('node:net').connect(${address.port}, '127.0.0.1');
socket.once('connect', () => process.send(process.pid));
setInterval(() => {}, 1000);`,
      );
      const command = await nodeBinary(
        f.root,
        "git-standin",
        `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
child.once('message', (pid) => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(pid)); ${mode === "exit" ? "process.exit(0);" : mode === "overflow" ? "process.stdout.write(Buffer.alloc(300000, 120));" : "process.stdout.write('ready\\n');"} });
setInterval(() => {}, 1000);`,
      );
      const runtime = gitRuntime();
      const ready = Promise.withResolvers<void>();
      let expire: (() => void) | undefined;
      manager = await PluginManager.open({
        root: join(f.root, "isolated"),
        now: () => 0,
        id: () => "overflow",
        git: {
          ...runtime,
          command,
          ...(mode === "timeout"
            ? {
                spawn(options) {
                  const child = runtime.spawn(options);
                  child.stdout.once("data", () => ready.resolve());
                  return child;
                },
                schedule(callback) {
                  expire = callback;
                  return () => {};
                },
              }
            : {}),
        },
      });
      const preparing = manager.prepare({ repository: f.repo, ref: "main", name: "sample" });
      const rejection = expect(preparing).rejects.toThrow(
        mode === "overflow"
          ? "Git output exceeds byte limit"
          : mode === "timeout"
            ? "Git operation timed out"
            : undefined,
      );
      if (mode === "timeout") {
        await ready.promise;
        if (!expire) throw new Error("Missing timeout callback");
        expire();
      }
      await rejection;
      pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(await readFile(pidFile, "utf8"));
      // Kernel socket closure acknowledges termination; immediate ps samples race SIGKILL delivery.
      await disconnected.promise;
      expect(connection?.destroyed).toBe(true);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      connection?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      manager?.close();
      await f.close();
    }
  },
);
