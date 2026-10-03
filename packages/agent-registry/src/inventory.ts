import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RegistryInstallation, AcpIdentity } from "@ace/protocol";
import { findExecutable, isPackageRunner } from "@ace/provider-kit/discovery";
import { matchProfile, type CompatibilityProfile } from "./profiles.ts";
import { limits } from "./decode.ts";
export const LocalInstallation = z.object({
  metadata: RegistryInstallation,
  command: z.string().min(1).max(4096).refine(isAbsolute),
  args: z.array(z.string().max(4096)).max(64),
  env: z
    .record(z.string().max(256), z.string().max(8192))
    .refine((value) => Object.keys(value).length <= 128),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bridgeCommand: z.string().max(4096).optional(),
  bridgeDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type LocalInstallation = z.infer<typeof LocalInstallation>;
export type LocalBinding = {
  acpAgentId: string;
  installationId: string;
  instanceId: string;
  version: string;
  command: string;
  args: readonly string[];
  source?: string;
  env?: Readonly<Record<string, string>>;
  underlyingCommand?: string;
};
export type LaunchPlan = Readonly<{
  identity: AcpIdentity;
  version: string;
  command: string;
  args: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  profile?: CompatibilityProfile;
}>;
export async function executableDigest(path: string): Promise<string> {
  if ((await stat(path)).size > 512 * 1024 * 1024) throw new Error("Executable exceeds bound");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new Error("Executable exceeds bound");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
export async function bindLocal(
  input: LocalBinding,
  environment: NodeJS.ProcessEnv,
): Promise<LocalInstallation> {
  const command = await findExecutable(input.command, environment);
  if (!command) throw new Error("Local ACP executable unavailable");
  // Package runners cannot satisfy an offline installed-artifact binding.
  const path = await realpath(command);
  if ([command, path].some(isPackageRunner))
    throw new Error("Bind an installed agent entrypoint, not a package runner");
  const bridge =
    input.acpAgentId === "official:claude-acp"
      ? "claude"
      : input.acpAgentId === "official:codex-acp"
        ? "codex"
        : undefined;
  const underlying = bridge
    ? await findExecutable(input.underlyingCommand ?? bridge, environment)
    : undefined;
  if (bridge && !underlying) throw new Error("Bridge requires the user's installed native CLI");
  const bridgeCommand = underlying ? await realpath(underlying) : undefined;
  const profile = input.acpAgentId.startsWith("official:")
    ? matchProfile(input.acpAgentId.slice(9), input.version)
    : undefined;
  const env = { ...input.env, ...profile?.env };
  // Local bindings never persist a user credential or a config-home environment.
  if (
    Object.keys(env).some((key) =>
      /token|key|secret|password|credential|authorization|home|config_dir/i.test(key),
    )
  )
    throw new Error("Private launch environment must be injected by the account owner");
  return LocalInstallation.parse({
    metadata: {
      acpAgentId: input.acpAgentId,
      installationId: input.installationId,
      instanceId: input.instanceId,
      version: input.version,
      source: input.source ?? "user-local",
      profileRevision: profile?.revision ?? "generic-v1",
      evidence: "user_local_binding",
    },
    command: path,
    args: [...input.args],
    env,
    executableDigest: await executableDigest(path),
    ...(bridgeCommand
      ? { bridgeCommand, bridgeDigest: await executableDigest(bridgeCommand) }
      : {}),
  });
}
export class LocalInventory {
  #entries = new Map<string, LocalInstallation>();
  constructor(entries: readonly LocalInstallation[] = []) {
    for (const entry of entries) this.add(entry);
  }
  add(input: LocalInstallation): void {
    const entry = LocalInstallation.parse(input);
    const key = entry.metadata.installationId;
    if (this.#entries.has(key)) throw new Error("Installation identity is immutable");
    if (this.#entries.size >= limits.installations)
      throw new Error("Installation capacity reached");
    this.#entries.set(key, entry);
  }
  all(): LocalInstallation[] {
    return [...this.#entries.values()].map((value) => structuredClone(value));
  }
  list(): RegistryInstallation[] {
    return [...this.#entries.values()].map((value) => structuredClone(value.metadata));
  }
  has(identity: AcpIdentity): boolean {
    const entry = this.#entries.get(identity.installationId);
    return (
      !!entry &&
      entry.metadata.acpAgentId === identity.acpAgentId &&
      entry.metadata.instanceId === identity.instanceId
    );
  }
  async resolve(input: AcpIdentity, environment: NodeJS.ProcessEnv): Promise<LaunchPlan> {
    const identity = AcpIdentity.parse(input);
    const entry = this.#entries.get(identity.installationId);
    if (!entry || !this.has(identity)) throw new Error("Approved ACP installation unavailable");
    if ((await executableDigest(entry.command)) !== entry.executableDigest)
      throw new Error("ACP artifact changed; new approval required");
    const profile = identity.acpAgentId.startsWith("official:")
      ? matchProfile(identity.acpAgentId.slice(9), entry.metadata.version)
      : undefined;
    const env = { ...environment, ...entry.env };
    const bridgeVariable =
      identity.acpAgentId === "official:claude-acp"
        ? "CLAUDE_CODE_EXECUTABLE"
        : identity.acpAgentId === "official:codex-acp"
          ? "CODEX_PATH"
          : undefined;
    if (bridgeVariable) {
      if (
        !entry.bridgeCommand ||
        (await executableDigest(entry.bridgeCommand)) !== entry.bridgeDigest
      )
        throw new Error("Native bridge CLI changed or unavailable");
      env[bridgeVariable] = entry.bridgeCommand;
    }
    return Object.freeze({
      identity: Object.freeze(identity),
      version: entry.metadata.version,
      command: entry.command,
      args: Object.freeze([...entry.args]),
      env: Object.freeze(env),
      ...(profile ? { profile } : {}),
    });
  }
}
