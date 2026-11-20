import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitWorkspace } from "./index.ts";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { repository } from "./test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
test("Git overflow rejection reaps a process that ignores SIGTERM", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  const pidFile = join(repo.root, "pid");
  await repo.write(
    "probe.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(9000)); setInterval(()=>{},1000);`,
  );
  const workspace = new GitWorkspace(repo.root, {
    spawn: (options) =>
      options.args?.includes("check-ignore")
        ? spawnRawSupervised({
            ...options,
            command: process.execPath,
            args: [join(repo.root, "probe.cjs")],
          })
        : spawnRawSupervised(options),
  });
  await expect(workspace.inspect("probe.cjs")).rejects.toMatchObject({ code: "quota" });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("cancellation rejects and reaps a Git process holding its output open", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  const pidFile = join(repo.root, "pid");
  await repo.write(
    "probe.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const workspace = new GitWorkspace(repo.root, {
    signal: controller.signal,
    spawn: (options) => {
      const child = spawnRawSupervised({
        ...options,
        command: process.execPath,
        args: [join(repo.root, "probe.cjs")],
      });
      child.stdout.once("data", () => controller.abort());
      return child;
    },
  });
  await expect(workspace.inspect("probe.cjs")).rejects.toMatchObject({
    code: "busy",
    message: "Git operation cancelled",
  });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
