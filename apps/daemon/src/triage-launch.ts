import { spawn } from "node:child_process";
import { findExecutable, parseVersion } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import {
  triageInvocation,
  triageProviders,
  type TriageProviderEntry,
} from "@ace/diagnostics/triage";
import type { TriageProvider } from "@ace/protocol";

export type InstalledCli = TriageProviderEntry & { path: string; version?: string };

/** Installed provider CLIs, in menu order. Version probes are bounded and best-effort. */
export async function installedClis(env: NodeJS.ProcessEnv): Promise<InstalledCli[]> {
  const found = await Promise.all(
    triageProviders.map(async (entry): Promise<InstalledCli | undefined> => {
      const path = await resolveCommand(entry, env);
      if (!path) return undefined;
      const version = await probeOutput(path, ["--version"], { env, timeoutMs: 3_000 })
        .then((output) =>
          output.code === 0 ? parseVersion(entry.value, output.stdout) : undefined,
        )
        .catch(() => undefined);
      return { ...entry, path, ...(version ? { version: version.slice(0, 40) } : {}) };
    }),
  );
  return found.filter((cli): cli is InstalledCli => !!cli);
}

async function resolveCommand(entry: TriageProviderEntry, env: NodeJS.ProcessEnv) {
  for (const command of entry.commands) {
    const path = await findExecutable(command, env);
    if (path) return path;
  }
  return undefined;
}

/** Resolve only installed CLIs; no shell, installation or permission-bypass flags. */
export async function triageLaunch(
  provider: TriageProvider,
  prompt: string,
  env: NodeJS.ProcessEnv,
) {
  if (!prompt.trim() || Buffer.byteLength(prompt) > 96_000 || prompt.includes("\0"))
    throw new Error("The prompt must contain text and be at most 96 KB.");
  const entry = triageProviders.find((candidate) => candidate.value === provider);
  if (!entry) throw new Error("Unknown triage provider");
  const executable = await resolveCommand(entry, env);
  if (!executable)
    throw new Error(
      `${entry.label} (${entry.commands[0]}) is not installed. Install it and sign in, or rerun with --print and paste the prompt.`,
    );
  return { command: executable, args: triageInvocation(provider, prompt) };
}

const ignore = () => {};

/**
 * Hand the terminal to the provider CLI. While it runs, Ctrl-C belongs to the child
 * (agents use it to interrupt a turn), so ace ignores SIGINT and forwards termination.
 */
export async function runTriageHandoff(
  provider: TriageProvider,
  prompt: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const launch = await triageLaunch(provider, prompt, env);
  const child = spawn(launch.command, launch.args, { stdio: "inherit", env });
  const forward = (signal: NodeJS.Signals) => () => {
    child.kill(signal);
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGINT", ignore);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  }
}
