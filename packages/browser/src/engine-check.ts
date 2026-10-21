import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromiumArtifact } from "./chromium-manifest.ts";
import {
  chromeLaunchFacts,
  linuxMachine,
  smallSharedMemory,
  type LinuxMachine,
} from "./launch-diagnosis.ts";
import { classifyChromeLaunch, type ChromeLaunchProblem } from "./launch-failure.ts";
import {
  chromiumAppArmorInstall,
  chromiumAppArmorProfile,
  chromiumAttachmentFor,
  chromiumAttachmentForExecutable,
  defaultChromiumAttachment,
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
  /** Bound on each Chrome run; the whole check takes at most twice this. Default 6 s. */
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
}
function run(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on(
      "data",
      (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(0, 8192)),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr = (stderr + chunk.toString("utf8")).slice(0, 8192);
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
      timedOut = true;
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
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}

function problemVerdict(
  problem: ChromeLaunchProblem,
  sandboxFix: string,
  stderr: string,
): EngineVerdict {
  const optOut =
    "Or, accepting the risk, set ACE_CHROMIUM_NO_SANDBOX=1 in the daemon's environment to run ace's browser without its sandbox.";
  switch (problem.kind) {
    case "missing_libraries":
      return {
        status: "fail",
        message: `ace's browser cannot start: missing ${problem.libraries.join(", ")}`,
        fix: problem.install
          ? `Install them: ${problem.install}`
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
            ? `Install ace's AppArmor profile once:\n${sandboxFix}\n${optOut}`
            : problem.cause === "userns_disabled"
              ? `Enable them: sudo sysctl -w kernel.unprivileged_userns_clone=1 (persist it in /etc/sysctl.d). ${optOut}`
              : `Chrome said: ${stderrLine(stderr)}. ${optOut}`,
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
  return (
    lines.find((line) => /FATAL|ERROR|error while loading/.test(line)) ??
    lines.at(-1) ??
    ""
  ).slice(0, 600);
}

/**
 * `ace doctor`'s check of the browser engine ace actually uses: the executable resolves, prints
 * its version, and starts headless (with its sandbox unless the person opted out) within a bound.
 */
export async function checkBrowserEngine(options: EngineCheckOptions): Promise<EngineVerdict> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const machine = options.machine ?? linuxMachine;
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
  const sandboxFix = chromiumAppArmorInstall(
    chromiumAppArmorProfile(
      !engine.pinned
        ? chromiumAttachmentForExecutable(engine.path)
        : resolve(options.dataDir) === join(options.home ?? homedir(), ".ace")
          ? defaultChromiumAttachment
          : chromiumAttachmentFor(resolve(options.dataDir)),
    ),
  );
  const diagnose = async (stderr: string) =>
    problemVerdict(
      classifyChromeLaunch(await chromeLaunchFacts(engine.path, stderr, machine)),
      sandboxFix,
      stderr,
    );
  const version = await run(engine.path, ["--version"], timeoutMs, options.signal);
  if (version.code !== 0) return diagnose(version.stderr);
  const name = version.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "Chromium";
  const profile = await mkdtemp(join(tmpdir(), "ace-doctor-chrome-"));
  try {
    const started = await run(
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
        "--dump-dom",
        "about:blank",
      ],
      timeoutMs,
      options.signal,
    );
    if (started.timedOut)
      return {
        status: "warn",
        message: `${name} did not finish a headless start within ${timeoutMs / 1000} s`,
        fix: "The machine may be busy; run ace doctor again. If it persists, check the daemon log when an agent opens the browser.",
      };
    if (started.code !== 0 || !started.stdout.includes("<html")) return diagnose(started.stderr);
    return sandbox
      ? {
          status: "ok",
          message: `${name} starts headless with its sandbox`,
          fix: "No action needed.",
        }
      : {
          status: "warn",
          message: `${name} starts headless without its sandbox (ACE_CHROMIUM_NO_SANDBOX=1)`,
          fix: `Pages run without Chrome's sandbox. On Ubuntu 23.10+ install ace's AppArmor profile instead and unset ACE_CHROMIUM_NO_SANDBOX:\n${sandboxFix}`,
        };
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
