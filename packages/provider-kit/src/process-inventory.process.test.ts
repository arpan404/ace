import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ProcessInventory } from "./process-inventory.ts";
const execute = promisify(execFile);
test("restart recovery kills a recorded orphan group after its owning daemon is hard-killed", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-process-journal-"));
  const path = join(home, "processes.sqlite");
  const manager = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {observeProcessGroups,spawnSupervised} from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};
    import {ProcessInventory} from ${JSON.stringify(new URL("./process-inventory.ts", import.meta.url).href)};
    const inventory = new ProcessInventory(${JSON.stringify(path)});
    observeProcessGroups(inventory);
    const child = spawnSupervised({command:process.execPath,args:['-e','console.log("ready");setInterval(()=>{},1000)'],env:process.env,name:'synthetic-provider'});
    child.stdout.once('line',()=>console.log(JSON.stringify({pid:child.pid})));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pid: number | undefined;
  try {
    const text = await new Promise<string>((resolve, reject) => {
      manager.once("error", reject);
      manager.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pid" in parsed) ||
      typeof parsed.pid !== "number"
    )
      throw new Error("Missing child pid");
    pid = parsed.pid;
    manager.kill("SIGKILL");
    await new Promise<void>((resolve) => manager.once("exit", () => resolve()));
    const inventory = new ProcessInventory(path);
    try {
      inventory.recover();
    } finally {
      inventory.close();
    }
    let dead = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await execute("ps", ["-p", String(pid), "-o", "stat="]).catch(() => ({
        stdout: "",
      }));
      if (!status.stdout.trim() || status.stdout.trim().startsWith("Z")) {
        dead = true;
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(dead).toBe(true);
  } finally {
    manager.kill("SIGKILL");
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already cleaned. */
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
