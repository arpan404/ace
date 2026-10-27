import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { lineReader, type ProcessExit } from "@ace/provider-kit/process";
import { Helper } from "../helper.ts";
import { spawnWindowsHelper } from "../helper.ts";
import type { Frame } from "../frames.ts";
import { windowsEndpoint } from "../transport.ts";

// Real-Windows screen tests: the native helper built by CI drives windows these
// PowerShell fixtures own on the disposable runner desktop, never anyone else's.
const HelperEnv = z.object({ ACE_WINDOWS_SCREEN_HELPER: z.string().min(1) });
const SystemEnv = z.object({ SystemRoot: z.string().min(1) });

/** Starts the CI-built native Windows helper, keeping the tail of its stderr for diagnostics. */
export async function nativeWindowsHelper(options: {
  onFrame?: (frame: Frame) => void;
  onFailure: (error: Error) => void;
}) {
  let stderr = "";
  let exited: Promise<ProcessExit> | undefined;
  const helper = await Helper.open({
    spawn: (spawnOptions) => {
      const proc = spawnWindowsHelper(spawnOptions);
      proc.stderr.on("line", (line: string) => {
        stderr = (stderr + line + "\n").slice(-4096);
      });
      exited = proc.exited;
      return proc;
    },
    command: HelperEnv.parse(process.env).ACE_WINDOWS_SCREEN_HELPER,
    platform: "win32",
    endpoint: windowsEndpoint(randomUUID()),
    nextId: () => randomUUID(),
    onFrame: options.onFrame ?? (() => {}),
    onFailure: options.onFailure,
  });
  return { helper, stderr: () => stderr, exited: () => exited };
}

/**
 * Starts a PowerShell window fixture from this directory and waits for the first stdout line
 * that matches `Startup`. The fixture is killed when the test finishes.
 */
export async function ownedWindow<T>(
  script: "owned-edit-fixture.ps1" | "owned-input-fixture.ps1",
  env: Record<string, string>,
  Startup: z.ZodType<T>,
) {
  const powershell = join(
    SystemEnv.parse(process.env).SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const fixture = fileURLToPath(new URL(`./${script}`, import.meta.url));
  const child = spawn(powershell, ["-NoProfile", "-Sta", "-File", fixture], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  child.stdin.on("error", () => {});
  const lines = lineReader(child.stdout, 64 * 1024, () => child.kill());
  const close = async () => {
    lines.close();
    child.kill();
    await closed;
  };
  onTestFinished(close);
  const started = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 30_000);
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited before startup: ${stderr}`));
    });
    lines.on("line", (line: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = Startup.safeParse(raw);
      if (parsed.success) {
        clearTimeout(timer);
        resolve(parsed.data);
      }
    });
  });
  return { stdin: child.stdin, lines, started, stderr: () => stderr };
}
