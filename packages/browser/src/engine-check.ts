import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromiumArtifact } from "./chromium-manifest.ts";
import {
  chromeLaunchFacts,
  linuxMachine,
  sandboxFacts,
  smallSharedMemory,
  type LinuxMachine,
} from "./launch-diagnosis.ts";
import {
  chromeLogText,
  classifyChromeLaunch,
  sandboxObstacle,
  type ChromeLaunchProblem,
} from "./launch-failure.ts";
import {
  chromiumAppArmorProfile,
  chromiumAppArmorProfileName,
  chromiumAppArmorProfilePath,
  chromiumAttachmentForEngine,
  type AppArmorProfile,
} from "./linux-sandbox.ts";

/** A doctor verdict on ace's browser engine. */
export interface EngineVerdict {
  status: "ok" | "warn" | "fail";
  message: string;
  fix: string;
}
export interface EngineCheckOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  /** Bound on each Chrome run; the whole check takes at most twice this. Default 10 s. */
  timeoutMs?: number;
  machine?: LinuxMachine;
}

/** The Chromium ace's daemon would run, as `ACE_CHROMIUM_PATH` or its pinned Chrome for Testing. */
export function engineExecutable(options: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
}): { path: string; pinned?: string } {
  if (options.env.ACE_CHROMIUM_PATH) return { path: resolve(options.env.ACE_CHROMIUM_PATH) };
  const artifact = chromiumArtifact(options.platform, options.arch);
  return {
    path: join(
      options.dataDir,
      "chromium",
      `${artifact.version}-${artifact.checksum}`,
      artifact.executable,
    ),
    pinned: artifact.version,
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Over the debugging pipe: Chrome opened a page. */
  pageOpened: boolean;
}
type Child = ReturnType<typeof spawn>;
/** Collects stderr and settles when Chrome exits, killing its process group at the bound. */
function supervise(child: Child, timeoutMs: number, run: Run): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    child.stderr?.on("data", (chunk: Buffer) => {
      if (run.stderr.length < 8192)
        run.stderr = (run.stderr + chunk.toString("utf8")).slice(0, 8192);
    });
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    };
    const timer = setTimeout(() => {
      run.timedOut = true;
      kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      // Helpers Chrome left behind in its group go with it.
      kill();
      resolveRun({ ...run, code });
    });
  });
}
const emptyRun = (): Run => ({
  code: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  pageOpened: false,
});

/** `chrome --version`: proves the executable and its shared libraries load. */
function version(executable: string, timeoutMs: number, signal: AbortSignal): Promise<Run> {
  const child = spawn(executable, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    detached: process.platform !== "win32",
  });
  const run = emptyRun();
  child.stdout?.on("data", (chunk: Buffer) => {
    run.stdout = (run.stdout + chunk.toString("utf8")).slice(0, 8192);
  });
  return supervise(child, timeoutMs, run);
}

/**
 * Starts Chrome the way ace does, over `--remote-debugging-pipe`, opens a blank page (which
 * starts a sandboxed renderer) and closes it.
 */
function startHeadless(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Run> {
  const child = spawn(executable, [...args, "--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    signal,
    detached: process.platform !== "win32",
  });
  const run = emptyRun();
  const input = child.stdio[3];
  const output = child.stdio[4];
  const send = (id: number, method: string, params?: object) => {
    if (input instanceof Writable)
      input.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\0`);
  };
  let pending = "";
  if (output instanceof Readable)
    output.on("data", (chunk: Buffer) => {
      pending = (pending + chunk.toString("utf8")).slice(-1024 * 1024);
      const messages = pending.split("\0");
      pending = messages.pop() ?? "";
      for (const message of messages) {
        const reply = PipeReply.safeParse(parseJson(message));
        if (!reply.success || reply.data.id !== 2) continue;
        run.pageOpened = reply.data.result !== undefined;
        send(3, "Browser.close");
      }
    });
  if (input instanceof Writable) input.on("error", () => {});
  send(1, "Browser.getVersion");
  send(2, "Target.createTarget", { url: "about:blank" });
  return supervise(child, timeoutMs, run);
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const PipeReply = z.object({ id: z.number().optional(), result: z.unknown().optional() });

/**
 * Report text points at `ace doctor --fix` instead of carrying the commands: the shared report is
 * redacted, and a redacted AppArmor profile or path no longer works. `--dry-run` prints them.
 */
export const appArmorRepairHint =
  "Run ace doctor --fix to install ace's AppArmor profile (sudo asks for your password); ace doctor --dry-run prints the commands.";

function problemVerdict(problem: ChromeLaunchProblem, stderr: string): EngineVerdict {
  const optOut =
    "Or, accepting the risk, set ACE_CHROMIUM_NO_SANDBOX=1 in the daemon's environment to run ace's browser without its sandbox.";
  switch (problem.kind) {
    case "missing_libraries":
      return {
        status: "fail",
        message: `ace's browser cannot start: missing ${problem.libraries.join(", ")}`,
        fix: problem.install
          ? `Run ace doctor --fix to install them, or run: ${problem.install}`
          : `Install the packages that provide ${problem.libraries.join(", ")}.`,
      };
    case "sandbox_blocked":
      return {
        status: "fail",
        message:
          problem.cause === "apparmor"
            ? "ace's browser cannot start its sandbox: AppArmor restricts user namespaces (Ubuntu 23.10+)"
            : problem.cause === "userns_disabled"
              ? "ace's browser cannot start its sandbox: unprivileged user namespaces are disabled"
              : "ace's browser cannot start its sandbox",
        fix:
          problem.cause === "apparmor"
            ? `${appArmorRepairHint} ${optOut}`
            : problem.cause === "userns_disabled"
              ? `Enable them: sudo sysctl -w kernel.unprivileged_userns_clone=1 (persist it in /etc/sysctl.d). ${optOut}`
              : `Chrome said: ${stderrLine(stderr).replace(/\.+$/, "")}. ${optOut}`,
      };
    case "running_as_root":
      return {
        status: "fail",
        message: "ace runs as root, where Chrome refuses to start its sandbox",
        fix: `Run ace as a normal user. ${optOut}`,
      };
    case "unknown":
      return {
        status: "fail",
        message: `ace's browser did not start: ${stderrLine(stderr) || "no output"}`,
        fix: "Check the daemon log for the full error, or set ACE_CHROMIUM_PATH to a working Chromium.",
      };
  }
}
function stderrLine(stderr: string): string {
  const lines = stderr.trim().split("\n");
  return chromeLogText(
    lines.find((line) => /FATAL|ERROR|error while loading/.test(line)) ?? lines.at(-1) ?? "",
  ).slice(0, 600);
}

/**
 * `ace doctor`'s check of the browser engine ace actually uses: the executable resolves, prints
 * its version, and starts headless (with its sandbox unless the person opted out) within a bound.
 */
export async function checkBrowserEngine(options: EngineCheckOptions): Promise<EngineVerdict> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const machine = options.machine ?? linuxMachine;
  if (platform === "win32") return checkWindowsEngine(options, arch, timeoutMs);
  let engine: { path: string; pinned?: string };
  try {
    engine = engineExecutable({ dataDir: options.dataDir, env: options.env, platform, arch });
  } catch {
    return {
      status: "fail",
      message: `ace has no browser engine for ${platform}-${arch}`,
      fix: "Set ACE_CHROMIUM_PATH to a Chromium or Chrome executable for this machine.",
    };
  }
  try {
    await access(engine.path, constants.X_OK);
  } catch {
    return engine.pinned
      ? {
          status: "ok",
          message: `ace's Chrome ${engine.pinned} downloads on first browser use`,
          fix: "Run ace doctor again after the first browser use to check that it starts.",
        }
      : {
          status: "fail",
          message: "ACE_CHROMIUM_PATH is not an executable file",
          fix: "Point ACE_CHROMIUM_PATH at a Chromium or Chrome executable, or unset it to use ace's Chrome.",
        };
  }
  const sandbox = options.env.ACE_CHROMIUM_NO_SANDBOX !== "1";
  const diagnose = async (stderr: string) =>
    problemVerdict(
      classifyChromeLaunch(await chromeLaunchFacts(engine.path, stderr, machine)),
      stderr,
    );
  const printed = await version(engine.path, timeoutMs, options.signal);
  if (printed.code !== 0) return diagnose(printed.stderr);
  const name = printed.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "Chromium";
  const profile = await mkdtemp(join(tmpdir(), "ace-doctor-chrome-"));
  try {
    const started = await startHeadless(
      engine.path,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
        ...(platform === "linux" ? ["--password-store=basic"] : []),
        ...(platform === "linux" && smallSharedMemory() ? ["--disable-dev-shm-usage"] : []),
        ...(sandbox ? [] : ["--no-sandbox"]),
      ],
      timeoutMs,
      options.signal,
    );
    if (!started.pageOpened && started.timedOut)
      return {
        status: "warn",
        message: `${name} did not finish a headless start within ${timeoutMs / 1000} s`,
        fix: "The machine may be busy; run ace doctor again. If it persists, check the daemon log when an agent opens the browser.",
      };
    if (!started.pageOpened) return diagnose(started.stderr);
    if (sandbox)
      return {
        status: "ok",
        message: `${name} starts headless with its sandbox`,
        fix: "No action needed.",
      };
    const obstacle =
      platform === "linux" ? sandboxObstacle(await sandboxFacts(machine)) : undefined;
    return {
      status: "warn",
      message: `${name} starts headless without its sandbox (ACE_CHROMIUM_NO_SANDBOX=1)`,
      fix:
        obstacle === "apparmor"
          ? `Pages run without Chrome's sandbox. Install ace's AppArmor profile instead, then unset ACE_CHROMIUM_NO_SANDBOX. ${appArmorRepairHint}`
          : obstacle === "userns_disabled"
            ? "Pages run without Chrome's sandbox. Enable user namespaces instead (sudo sysctl -w kernel.unprivileged_userns_clone=1, persisted in /etc/sysctl.d) and unset ACE_CHROMIUM_NO_SANDBOX."
            : "Pages run without Chrome's sandbox, and nothing on this machine blocks it: unset ACE_CHROMIUM_NO_SANDBOX.",
    };
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Windows: the engine is the pinned Chrome for Testing, or on ARM64 (which has no such build) the
 * installed Chrome or Edge, else the x64 build under emulation. Windows Chrome ignores
 * `--version` and opens a normal window, so its name and version come from its install folder.
 */
async function checkWindowsEngine(
  options: EngineCheckOptions,
  arch: string,
  timeoutMs: number,
): Promise<EngineVerdict> {
  const { detectChromium } = await import("./discovery.ts");
  const installed =
    arch === "arm64" && !options.env.ACE_CHROMIUM_PATH
      ? await detectChromium({ platform: "win32", env: options.env, dataDir: options.dataDir })
      : undefined;
  let engine: { path: string; pinned?: string };
  try {
    engine = installed
      ? { path: installed }
      : engineExecutable({
          dataDir: options.dataDir,
          env: options.env,
          platform: "win32",
          arch: arch === "arm64" ? "x64" : arch,
        });
  } catch {
    return {
      status: "fail",
      message: `ace has no browser engine for win32-${arch}`,
      fix: "Set ACE_CHROMIUM_PATH to a Chromium or Chrome executable for this machine.",
    };
  }
  try {
    await access(engine.path);
  } catch {
    return engine.pinned
      ? {
          status: "ok",
          message: `ace's Chrome ${engine.pinned} downloads on first browser use`,
          fix: "Run ace doctor again after the first browser use to check that it starts.",
        }
      : {
          status: "fail",
          message: "ACE_CHROMIUM_PATH is not an executable file",
          fix: "Point ACE_CHROMIUM_PATH at a Chromium or Chrome executable, or unset it to use ace's Chrome.",
        };
  }
  const sandbox = options.env.ACE_CHROMIUM_NO_SANDBOX !== "1";
  const name = await windowsBrowserName(engine.path);
  const profile = await mkdtemp(join(tmpdir(), "ace-doctor-chrome-"));
  try {
    const started = await startHeadless(
      engine.path,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(sandbox ? [] : ["--no-sandbox"]),
      ],
      timeoutMs,
      options.signal,
    );
    if (!started.pageOpened && started.timedOut)
      return {
        status: "warn",
        message: `${name} did not finish a headless start within ${timeoutMs / 1000} s`,
        fix: "The machine may be busy; run ace doctor again. If it persists, check the daemon log when an agent opens the browser.",
      };
    if (!started.pageOpened) return problemVerdict({ kind: "unknown" }, started.stderr);
    return sandbox
      ? {
          status: "ok",
          message: `${name} starts headless with its sandbox`,
          fix: "No action needed.",
        }
      : {
          status: "warn",
          message: `${name} starts headless without its sandbox (ACE_CHROMIUM_NO_SANDBOX=1)`,
          fix: "Pages run without Chrome's sandbox, and nothing on this machine blocks it: unset ACE_CHROMIUM_NO_SANDBOX.",
        };
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

/** Windows: "chrome 156.0.4314.42" from the version folder or manifest beside the executable. */
async function windowsBrowserName(executable: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const { basename, dirname } = await import("node:path");
  const entries = await readdir(dirname(executable)).catch(() => []);
  const versions = entries
    .map((entry) => /^(\d+\.\d+\.\d+\.\d+)(?:\.manifest)?$/.exec(entry)?.[1])
    .filter((version): version is string => version !== undefined)
    .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const product = basename(executable).replace(/\.exe$/i, "");
  const newest = versions.at(-1);
  return newest ? `${product} ${newest}` : product;
}

/** What `ace doctor --fix` can change on this machine so ace's browser starts. */
export interface EngineRepairs {
  /**
   * The system packages that provide the libraries Chrome could not load: `install` as a person
   * types it, `steps` as commands to run as root (no `sudo`).
   */
  packages?: { libraries: string[]; install: string; steps: string[][] };
  /** ace-chromium, when AppArmor restricts user namespaces and it isn't installed as needed. */
  profile?: AppArmorProfile;
}

/**
 * The repairs for the Chromium ace runs, for a doctor that saw its check fail. Reads the machine
 * (`--version` and the AppArmor switch) instead of the report, whose text is redacted.
 */
export async function browserEngineRepairs(options: EngineCheckOptions): Promise<EngineRepairs> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return {};
  const machine = options.machine ?? linuxMachine;
  let engine: { path: string; pinned?: string };
  try {
    engine = engineExecutable({
      dataDir: options.dataDir,
      env: options.env,
      platform,
      arch: options.arch ?? process.arch,
    });
    await access(engine.path, constants.X_OK);
  } catch {
    return {};
  }
  const repairs: EngineRepairs = {};
  const printed = await version(engine.path, options.timeoutMs ?? 10_000, options.signal);
  if (printed.code !== 0) {
    const problem = classifyChromeLaunch(
      await chromeLaunchFacts(engine.path, printed.stderr, machine),
    );
    if (problem.kind === "missing_libraries" && problem.install)
      repairs.packages = {
        libraries: problem.libraries,
        install: problem.install,
        steps: installSteps(problem.install),
      };
  }
  if ((await sandboxFacts(machine)).appArmorRestrictsUserns) {
    const text = chromiumAppArmorProfile(
      chromiumAttachmentForEngine({
        dataDir: resolve(options.dataDir),
        home: options.home ?? homedir(),
        ...(engine.pinned ? {} : { chromiumPath: engine.path }),
      }),
    );
    if ((await machine.readText(chromiumAppArmorProfilePath)) !== text)
      repairs.profile = { name: chromiumAppArmorProfileName, text };
  }
  return repairs;
}

function installSteps(install: string): string[][] {
  const words = install.split(" ").filter(Boolean);
  const command = words[0] === "sudo" ? words.slice(1) : words;
  // A fresh system or container has no package lists yet, so apt would find nothing.
  return command[0] === "apt-get" ? [["apt-get", "update"], command] : [command];
}
