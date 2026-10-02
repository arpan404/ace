import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PluginManager, gitRuntime } from "./index.ts";
import { fixture, writeFiles } from "./test-support.ts";

test.each(["overflow", "timeout", "exit"] as const)(
  "Git %s terminates descendants that retain stderr before completing",
  async (mode) => {
    const f = await fixture();
    let manager: PluginManager | undefined;
    try {
      const survived = join(f.root, "descendant-survived");
      const pidFile = join(f.root, "descendant-pid");
      const descendant = join(f.root, "descendant.cjs");
      await writeFile(
        descendant,
        `const fs = require('node:fs');
process.send(process.pid);
function check() {
  try { process.kill(process.ppid, 0); } catch {
    fs.writeFileSync(${JSON.stringify(survived)}, 'survived'); process.exit(0);
  }
  if (process.ppid === 1) { fs.writeFileSync(${JSON.stringify(survived)}, 'survived'); process.exit(0); }
  setImmediate(check);
}
check();`,
      );
      await writeFiles(join(f.root, "bin"), {
        git: `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
child.once('message', (pid) => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(pid)); ${mode === "exit" ? "process.exit(0);" : mode === "overflow" ? "process.stdout.write(Buffer.alloc(300000, 120));" : "process.stdout.write('ready\\n');"} });
setInterval(() => {}, 1000);
`,
      });
      await chmod(join(f.root, "bin/git"), 0o700);
      const runtime = gitRuntime();
      const ready = Promise.withResolvers<void>();
      let expire: (() => void) | undefined;
      manager = await PluginManager.open({
        root: join(f.root, "isolated"),
        now: () => 0,
        id: () => "overflow",
        git: {
          ...runtime,
          command: join(f.root, "bin/git"),
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
      const pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(await readFile(pidFile, "utf8"));
      const status = await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="]).then(
        (result) => result.stdout.trim(),
        (error: unknown) => {
          const parsed = z.object({ code: z.literal(1) }).safeParse(error);
          if (!parsed.success) throw error;
          return "";
        },
      );
      expect(status === "" || status.startsWith("Z")).toBe(true);
      if (mode !== "exit") await expect(lstat(survived)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      manager?.close();
      await f.close();
    }
  },
);
