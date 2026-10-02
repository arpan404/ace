import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { PluginManager, gitRuntime } from "./index.ts";
import { fixture } from "./test-support.ts";

test.each([
  ["timeout", "stderr", "."],
  ["normal exit", "stderr", "."],
  ["timeout", "stderr", "private/nested"],
  ["normal exit", "stderr", "private/nested"],
  ["timeout", "stdout", "."],
  ["normal exit", "stdout", "."],
  ["timeout", "stdout", "private/nested"],
  ["normal exit", "stdout", "private/nested"],
] as const)(
  "a detached Git helper terminates after %s while holding %s in %s",
  async (mode, pipe, directory) => {
    const f = await fixture();
    let manager: PluginManager | undefined;
    let pid: number | undefined;
    const pidFile = join(f.root, "escaped-pid");
    try {
      const script = join(f.root, "escaped.cjs");
      await writeFile(
        script,
        `require('node:fs').mkdirSync(${JSON.stringify(directory)}, { recursive: true });
process.chdir(${JSON.stringify(directory)}); process.send(process.pid); setInterval(() => {}, 1000);`,
      );
      const command = await nodeBinary(
        f.root,
        "git-standin",
        `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: ['ignore', '${pipe === "stdout" ? "inherit" : "ignore"}', '${pipe === "stderr" ? "inherit" : "ignore"}', 'ipc'] });
child.once('message', (pid) => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(pid)); process.stdout.write('helper ready', () => { process.stdout.end(); child.disconnect(); child.unref(); ${mode === "normal exit" ? "process.exit(1);" : ""} }); });`,
      );
      const runtime = gitRuntime();
      const ready = Promise.withResolvers<void>();
      let expire: (() => void) | undefined;
      const draining = Promise.withResolvers<() => void>();
      manager = await PluginManager.open({
        root: join(f.root, "manager"),
        now: () => 0,
        id: () => "escaped",
        git: {
          ...runtime,
          command,
          spawn(options) {
            const child = runtime.spawn({
              ...options,
              scheduleDrain(callback) {
                draining.resolve(callback);
                return () => {};
              },
            });
            child.stdout.once("data", () => ready.resolve());
            return child;
          },
          schedule(callback) {
            expire = callback;
            return () => {};
          },
        },
      });
      const preparing = manager.prepare({ repository: f.repo, ref: "main", name: "sample" });
      const rejection = expect(preparing).rejects.toThrow();
      await ready.promise;
      pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(await readFile(pidFile, "utf8"));
      if (mode === "timeout") {
        if (!expire) throw new Error("Missing timeout");
        expire();
      } else {
        (await draining.promise)();
      }
      await rejection;
      const result = await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="]).catch(
        (error: unknown) => {
          if (!z.object({ code: z.literal(1) }).safeParse(error).success) throw error;
          return { stdout: "" };
        },
      );
      expect(result.stdout.trim() === "" || result.stdout.trim().startsWith("Z")).toBe(true);
    } finally {
      if (pid === undefined) {
        try {
          pid = z.coerce
            .number()
            .int()
            .positive()
            .parse(await readFile(pidFile, "utf8"));
        } catch {}
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      manager?.close();
      await f.close();
    }
  },
);

test.each([".", "private/nested"])(
  "successful Git preparation terminates closed-pipe detached helpers in %s",
  async (directory) => {
    const f = await fixture();
    let manager: PluginManager | undefined;
    let pid: number | undefined;
    const pidFile = join(f.root, "closed-pipes-pid");
    try {
      const script = join(f.root, "closed-pipes.cjs");
      await writeFile(
        script,
        `require('node:fs').mkdirSync(${JSON.stringify(directory)}, { recursive: true });
process.chdir(${JSON.stringify(directory)}); process.send(process.pid); setInterval(() => {}, 1000);`,
      );
      const command = await nodeBinary(
        f.root,
        "git-proxy",
        `const { spawn, execFileSync } = require('node:child_process');
function git() { execFileSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' }); }
if (process.argv.includes('init')) {
  const child = spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', pid => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(pid)); child.disconnect(); child.unref(); git(); });
} else git();`,
      );
      manager = await PluginManager.open({
        root: join(f.root, "isolated"),
        now: () => 0,
        id: () => "closed-pipes",
        git: { ...gitRuntime(), command },
      });
      const review = await manager.prepare({ repository: f.repo, ref: "main", name: "sample" });
      expect(review.name).toBe("sample");
      pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(await readFile(pidFile, "utf8"));
      const output = await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="]).catch(
        (error: unknown) => {
          if (!z.object({ code: z.literal(1) }).safeParse(error).success) throw error;
          return { stdout: "" };
        },
      );
      expect(output.stdout.trim() === "" || output.stdout.trim().startsWith("Z")).toBe(true);
    } finally {
      if (pid === undefined) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
        } catch {}
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      manager?.close();
      await f.close();
    }
  },
);
