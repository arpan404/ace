import { realpath } from "node:fs/promises";
import { findExecutable, isPackageRunner } from "./executable.ts";
import type { DiscoveryResult } from "./types.ts";
import { probeOutput } from "../process.ts";
import type { AuthStatus } from "./parsers.ts";
export type DiscoveryDescriptor = Readonly<{
  command: string;
  versionArgs: readonly string[];
  version(output: string): string | undefined;
  loginHint: string;
  /** Only documented read-only status commands belong here. */
  auth?: { args: readonly string[]; parse(output: string): AuthStatus };
}>;
export type DescriptorOptions = {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  probe?: typeof probeOutput;
};
/** Caller supplies only known profile commands, explicit local paths or approved artifacts. */
export async function discoverDescriptor(
  descriptor: DiscoveryDescriptor,
  options: DescriptorOptions,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    installed: false,
    auth: "unknown",
    loginHint: descriptor.loginHint,
  };
  if (isPackageRunner(descriptor.command)) throw new Error("Discovery cannot use package runners");
  const command = await findExecutable(descriptor.command, options.env);
  if (!command) return result;
  if (isPackageRunner(command) || isPackageRunner(await realpath(command)))
    throw new Error("Discovery cannot use package runners");
  result.installed = true;
  result.path = command;
  const probe = options.probe ?? probeOutput;
  const config = {
    env: options.env,
    timeoutMs: options.timeoutMs ?? 4000,
    maxOutputBytes: 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const results = await Promise.allSettled([
    probe(command, [...descriptor.versionArgs], config),
    ...(descriptor.auth ? [probe(command, [...descriptor.auth.args], config)] : []),
  ]);
  const version = results[0];
  if (version?.status === "fulfilled" && version.value.code === 0) {
    const parsed = descriptor.version(version.value.stdout);
    if (parsed) result.version = parsed;
  }
  const auth = results[1];
  if (descriptor.auth && auth?.status === "fulfilled")
    Object.assign(result, descriptor.auth.parse(auth.value.stdout || auth.value.stderr));
  if (results.some((value) => value.status === "rejected")) result.error = "Metadata probe failed";
  return result;
}
