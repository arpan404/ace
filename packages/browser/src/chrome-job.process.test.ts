import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { executablePath } from "./test-support.ts";

const exec = promisify(execFile);

/** Every process whose command line names `profile`: Chrome's whole tree, whatever its type. */
async function profileProcesses(profile: string): Promise<number[]> {
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const rows = z
    .array(z.object({ ProcessId: z.number(), CommandLine: z.string().nullable() }))
    .parse([JSON.parse(stdout)].flat());
  return rows
    .filter((row) => row.CommandLine?.includes(profile) && row.ProcessId !== process.pid)
    .filter((row) => !row.CommandLine?.includes("node"))
    .map((row) => row.ProcessId);
}

test.runIf(process.platform === "win32" && executablePath)(
  "Windows: ace's Chrome tree ends when the daemon process dies without closing it",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-crash-"));
    const index = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
    const daemon = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { BrowserService } = await import(${JSON.stringify(index)});
         const service = new BrowserService({ dataDir: process.argv[1], executablePath: process.argv[2] });
         await service.open({ threadId: "thread", workspaceId: "workspace" });
         await service.execute("thread", { action: "navigate", url: "about:blank" });
         console.log("ready");
         setInterval(() => {}, 1000);`,
        home,
        executablePath ?? "",
      ],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    try {
      const [line] = (await once(daemon.stdout, "data")) as [Buffer];
      expect(line.toString()).toContain("ready");
      const running = await profileProcesses(home);
      // The browser, its GPU process and at least one renderer.
      expect(running.length).toBeGreaterThanOrEqual(3);
      // TerminateProcess: nothing in the daemon runs, as in a crash.
      daemon.kill("SIGKILL");
      await once(daemon, "exit");
      await vi.waitFor(async () => expect(await profileProcesses(home)).toEqual([]), {
        timeout: 15_000,
        interval: 500,
      });
    } finally {
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
      for (const pid of await profileProcesses(home).catch(() => []))
        await exec("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test.runIf(process.platform === "win32" && executablePath)(
  "Windows: closing ace's browser leaves none of its Chrome processes behind",
  async () => {
    const { BrowserService } = await import("./index.ts");
    const home = await mkdtemp(join(tmpdir(), "ace-browser-close-"));
    const service = new BrowserService({ dataDir: home, executablePath: executablePath ?? "" });
    try {
      await service.open({ threadId: "thread", workspaceId: "workspace" });
      await service.execute("thread", { action: "navigate", url: "about:blank" });
      expect((await profileProcesses(home)).length).toBeGreaterThanOrEqual(3);
      await service.close();
      await vi.waitFor(async () => expect(await profileProcesses(home)).toEqual([]), {
        timeout: 15_000,
        interval: 500,
      });
    } finally {
      await service.close().catch(() => {});
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  },
);
