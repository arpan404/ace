import { expect, test } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withInstallLock } from "./index.ts";
test(
  "a competing updater cannot mutate files and a killed owner releases its lock",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-mutex-"));
    const owner = spawn(
      process.execPath,
      [
        "-e",
        `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(join(root, ".update-lock.db"))});db.exec("BEGIN IMMEDIATE");process.stdout.write("locked");setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((ready, reject) => {
        owner.stdout.once("data", () => ready());
        owner.once("error", reject);
        owner.once("exit", () => reject(new Error("Owner exited before lock")));
      });
      const work = () => writeFile(join(root, "effect"), "installed");
      await expect(withInstallLock(root, work)).rejects.toThrow("locked");
      await expect(readFile(join(root, "effect"))).rejects.toMatchObject({ code: "ENOENT" });
      const exit = once(owner, "exit");
      owner.kill("SIGKILL");
      await exit;
      await withInstallLock(root, work);
      expect(await readFile(join(root, "effect"), "utf8")).toBe("installed");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exit = once(owner, "exit");
        owner.kill("SIGKILL");
        await exit;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
