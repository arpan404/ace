import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
         const { createServer } = await import("node:http");
         const server = createServer((_request, response) => response.end("<title>page</title>"));
         await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
         const service = new BrowserService({ dataDir: process.argv[1], executablePath: process.argv[2] });
         await service.open({ threadId: "thread", workspaceId: "workspace" });
         await service.execute("thread", { action: "navigate", url: "http://127.0.0.1:" + server.address().port + "/" });
         console.log("ready");
         setInterval(() => {}, 1000);`,
        home,
        executablePath ?? "",
      ],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    try {
      // A daemon that fails to start exits instead of printing: fail rather than wait forever.
      const started = await Promise.race([
        once(daemon.stdout, "data").then(([line]) => String(line)),
        once(daemon, "exit").then(([code]) => `exited ${String(code)}`),
      ]);
      expect(started).toContain("ready");
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
    const server = createServer((_request, response) => response.end("<title>page</title>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    try {
      await service.open({ threadId: "thread", workspaceId: "workspace" });
      await service.execute("thread", {
        action: "navigate",
        url: `http://127.0.0.1:${address.port}/`,
      });
      expect((await profileProcesses(home)).length).toBeGreaterThanOrEqual(3);
      await service.close();
      await vi.waitFor(async () => expect(await profileProcesses(home)).toEqual([]), {
        timeout: 15_000,
        interval: 500,
      });
    } finally {
      server.closeAllConnections();
      server.close();
      await service.close().catch(() => {});
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  },
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stand-in browser that starts a child in its first instant and reports the child's pid. */
const spawnsAtOnce = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
process.stderr.write("child " + child.pid + "\\n");
setInterval(() => {}, 1000);`;

test.runIf(process.platform === "win32")(
  "Windows: a child the browser starts at once is inside its job, even when joining the job is slow",
  async () => {
    const { chromeJobs } = await import("./chrome-job.ts");
    const { createRetainedJob } = await import("@ace/provider-kit/process-containment");
    const profile = await mkdtemp(join(tmpdir(), "ace-browser-gate-"));
    const jobs = chromeJobs({
      spawn,
      // A slow join: without the gate the stand-in would start its child before it.
      createJob: () => {
        const job = createRetainedJob();
        return {
          ...job,
          assign(pid) {
            const until = performance.now() + 750;
            while (performance.now() < until);
            job.assign(pid);
          },
        };
      },
    });
    const guard = await jobs.guard(profile);
    const browser = jobs.spawn(
      process.execPath,
      ["-e", spawnsAtOnce, "--", `--user-data-dir=${profile}`],
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      },
    );
    try {
      let text = "";
      const pid = await new Promise<number>((resolve, reject) => {
        browser.stderr?.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const found = /child (\d+)/.exec(text)?.[1];
          if (found) resolve(Number(found));
        });
        browser.once("exit", () => reject(new Error(`The stand-in exited: ${text}`)));
      });
      expect(alive(pid)).toBe(true);
      // Releasing the job ends every member, the child the stand-in started first included.
      await guard.close();
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
    } finally {
      browser.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "Windows: a browser that can't join its job never runs, and its launch fails",
  async () => {
    const { chromeJobs } = await import("./chrome-job.ts");
    const { createRetainedJob } = await import("@ace/provider-kit/process-containment");
    const profile = await mkdtemp(join(tmpdir(), "ace-browser-gate-"));
    const marker = join(profile, "ran");
    const jobs = chromeJobs({
      spawn,
      createJob: () => ({
        ...createRetainedJob(),
        assign: () => {
          throw new Error("Windows job assignment failed");
        },
      }),
    });
    const guard = await jobs.guard(profile);
    try {
      expect(() =>
        jobs.spawn(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
            "--",
            `--user-data-dir=${profile}`,
          ],
          { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
        ),
      ).toThrow("Windows job assignment failed");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await expect(stat(marker)).rejects.toThrow();
    } finally {
      await guard.close().catch(() => {});
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  },
  60_000,
);
