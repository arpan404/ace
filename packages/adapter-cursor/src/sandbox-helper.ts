import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Why Cursor's Linux sandbox helper (`@cursor/sdk-linux-<arch>/bin/cursorsandbox`) cannot run.
 *
 * The SDK checks the helper once per process and, when it fails, reports only "sandboxing is
 * not supported in this environment", keeping the loader's words in its own log. The arm64
 * helper of @cursor/sdk 1.0.35 needs glibc 2.39 while ace runs on glibc 2.31 (ADR 0093), so
 * on Ubuntu 22.04 or Debian 12 Cursor's sandboxed mode cannot start. ace can't rebuild the
 * helper, and the SDK's only other path is no sandbox at all, which ace never picks for the
 * person: it says what is missing and which mode still works.
 *
 * On Ubuntu 23.10+ AppArmor also blocks the user namespaces the helper creates, whatever the
 * glibc, until a profile grants them. Under the desktop app the helper inherits the app's
 * profile once its sandbox is set up; a standalone daemon gets the profile from `ace doctor --fix`.
 */
export type HelperProblem =
  | { kind: "glibc"; required: string; host?: string }
  | { kind: "apparmor" }
  | { kind: "library"; library: string }
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "windows" };

function newer(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** What the dynamic loader printed when the helper could not start, if that was the cause. */
export function helperLoadProblem(stderr: string, glibc?: string): HelperProblem | undefined {
  const versions = [...stderr.matchAll(/version [`']GLIBC_([\d.]+)' not found/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
  const required = versions.reduce<string | undefined>(
    (highest, version) => (highest === undefined || newer(version, highest) ? version : highest),
    undefined,
  );
  if (required) return { kind: "glibc", required, ...(glibc ? { host: glibc } : {}) };
  const library = /error while loading shared libraries: ([^:\s]+)/.exec(stderr)?.[1];
  if (library) return { kind: "library", library };
  return undefined;
}

const affected = "so Cursor can't run in Auto review, its sandboxed mode, on this machine";
const fallback = "Full access still works";
/** One message for the person and the agent: what is affected and what to do. */
export function sandboxUnavailableMessage(problem: HelperProblem): string {
  switch (problem.kind) {
    case "glibc":
      return `Cursor's sandbox helper needs glibc ${problem.required}${problem.host ? ` and this system has ${problem.host}` : ""}, ${affected}. ${fallback}; or run ace on a distribution with glibc ${problem.required} or newer.`;
    case "library":
      return `Cursor's sandbox helper can't load ${problem.library}, ${affected}. Install the package that provides ${problem.library}, or use Full access.`;
    case "apparmor":
      return `Ubuntu's AppArmor blocks the user namespaces Cursor's sandbox helper needs, ${affected}. Set up the sandbox in ace's desktop app, or run \`ace doctor --fix\` to install its profile; ${fallback}.`;
    case "missing":
      return `Cursor's sandbox helper is not installed with this ace, ${affected}. ${fallback}.`;
    case "other":
      return `Cursor's sandbox reports this system unsupported (its kernel features or a policy block it), ${affected}. ${fallback}.`;
    case "windows":
      return `Cursor's SDK has no file sandbox on Windows (its helper only filters network traffic), ${affected}. ${fallback}.`;
  }
}

const Report = z.object({
  header: z.object({ glibcVersionRuntime: z.string().max(32).optional() }).loose(),
});
/** The glibc this process runs on, as Node's diagnostic report states it. */
export function hostGlibc(): string | undefined {
  const report = Report.safeParse(process.report?.getReport());
  return report.success ? report.data.header.glibcVersionRuntime : undefined;
}

/** The helper's path beside the SDK, resolved the way the SDK's own install check does. */
export function sandboxHelperPath(arch: string = process.arch): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdk = createRequire(require.resolve("@cursor/sdk"));
    return join(
      dirname(sdk.resolve(`@cursor/sdk-linux-${arch}/package.json`)),
      "bin/cursorsandbox",
    );
  } catch {
    return undefined;
  }
}

/** Starts the helper once (`--help`) and returns what its loader printed. */
function loaderOutput(helper: string): Promise<{ started: boolean; stderr: string }> {
  return new Promise((done) => {
    execFile(
      helper,
      ["--help"],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
      (error, _out, stderr) => {
        const missing =
          error !== null && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
        done({ started: !missing, stderr: String(stderr) });
      },
    );
  });
}

/** `kernel.apparmor_restrict_unprivileged_userns` is 1: Ubuntu 23.10+'s default. */
export function userNamespacesRestricted(): boolean {
  try {
    return (
      readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1"
    );
  } catch {
    return false;
  }
}

/**
 * Why the helper can't sandbox Cursor here, on Linux after the SDK refused its sandbox.
 * `helper`, `glibc` and `restricted` default to the installed helper, this process's glibc
 * and the kernel's AppArmor user-namespace switch.
 */
export async function explainSandboxRefusal(
  options: { helper?: string | undefined; glibc?: string | undefined; restricted?: boolean } = {},
): Promise<string> {
  const helper = "helper" in options ? options.helper : sandboxHelperPath();
  if (!helper) return sandboxUnavailableMessage({ kind: "missing" });
  const run = await loaderOutput(helper);
  if (!run.started) return sandboxUnavailableMessage({ kind: "missing" });
  const glibc = "glibc" in options ? options.glibc : hostGlibc();
  const loader = helperLoadProblem(run.stderr, glibc);
  if (loader) return sandboxUnavailableMessage(loader);
  const restricted = options.restricted ?? userNamespacesRestricted();
  return sandboxUnavailableMessage({ kind: restricted ? "apparmor" : "other" });
}

/**
 * Runs the helper's own preflight, as the SDK does before it sandboxes a command: exit 0 when
 * it can sandbox here, 2 when the system lacks what it needs. The policy is the SDK's
 * smallest, a writable workspace in a scratch folder.
 */
export async function sandboxPreflight(
  helper: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ace-cursor-preflight-"));
  try {
    const policy = join(dir, "policy.json");
    await writeFile(
      policy,
      JSON.stringify({ sandbox: { type: "workspace_readwrite", cwd: dir } }),
      { mode: 0o600 },
    );
    return await new Promise((done) => {
      execFile(
        helper,
        ["--policy", policy, "--preflight-only", "--", "/bin/true"],
        { cwd: dir, timeout: 15_000, maxBuffer: 256 * 1024, ...(signal ? { signal } : {}) },
        (error, _out, stderr) => {
          const code =
            error === null
              ? 0
              : "code" in error && typeof error.code === "number"
                ? error.code
                : null;
          done({ code, stderr: String(stderr) });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
