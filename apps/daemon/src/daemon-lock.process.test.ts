import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonLockHeldError, acquireLock } from "./local-files.ts";

// A process test: the lock is the kernel's, so only a real process that dies holding it shows
// that a crashed or killed daemon never leaves a lock behind for the next start.
test("a daemon killed while holding the home's lock leaves it free for the next start", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-daemon-lock-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const module = fileURLToPath(new URL("./local-files.ts", import.meta.url));
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { acquireLock } = await import(${JSON.stringify(module)});
       globalThis.release = acquireLock(${JSON.stringify(home)});
       console.log("held");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  onTestFinished(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
  });
  const [line] = (await once(holder.stdout, "data")) as [Buffer];
  expect(line.toString().trim()).toBe("held");
  expect(() => acquireLock(home)).toThrow(DaemonLockHeldError);

  holder.kill("SIGKILL");
  await once(holder, "exit");
  const unlock = acquireLock(home);
  unlock();
});
