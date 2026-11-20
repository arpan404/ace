import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { RegistryInstallation, AcpIdentity, type RegistryPendingUpdate } from "@ace/protocol";
import { findExecutable, isPackageRunner } from "@ace/provider-kit/discovery";
import { requireMinimum, type CliId } from "@ace/provider-kit/cli-requirements";
import {
  matchProfile,
  profileFor,
  type CompatibilityProfile,
  type ProfileFit,
} from "./profiles.ts";
import { limits } from "./decode.ts";
import {
  UpdateApprovalRequired,
  approveUpdate,
  pendingUpdate,
  type Observed,
  type UpdateApproval,
} from "./approvals.ts";
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
const reviewedAgents: Readonly<Record<string, CliId>> = {
  "official:antigravity-acp": "antigravity",
  "official:gemini": "gemini",
  "official:qwen-code": "qwen-code",
  "official:claude-acp": "claude-acp",
  "official:codex-acp": "codex-acp",
  "official:goose": "goose",
  "official:auggie": "auggie",
};

/** The declared minimum behind a reviewed registry agent; none for other ACP agents. */
export function acpAgentCli(acpAgentId: string): CliId | undefined {
  return Object.hasOwn(reviewedAgents, acpAgentId) ? reviewedAgents[acpAgentId] : undefined;
}

export type LaunchPlan = Readonly<{
  identity: AcpIdentity;
  version: string;
  command: string;
  args: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  profile?: CompatibilityProfile;
  /** How the profile covers the approved version: verified on it, or only in its range. */
  profileFit?: ProfileFit;
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
/**
 * Coarsest timestamp a filesystem may keep (FAT keeps modification times to 2 s). A file
 * written this recently can change again without moving its times.
 */
const timestampSlackMs = 2000n;
type FileStats = Awaited<ReturnType<typeof statFile>>;
const statFile = (path: string) => stat(path, { bigint: true });
const fileIdentity = (info: FileStats) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");

/** Digests a previous run settled, as stored beside the inventory. Only a cache: bad data is dropped. */
const RememberedDigests = z
  .array(
    z.object({
      path: z.string().min(1).max(4096),
      file: z.string().max(256),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .max(256);
export type RememberedDigest = z.infer<typeof RememberedDigests>[number];
/** Where settled digests outlive the process; the next start reads them back. */
export type DigestMemory = {
  load(): Promise<unknown>;
  save(entries: readonly RememberedDigest[]): Promise<void>;
};

/**
 * The digest a launch checks its approval against, hashed again whenever the file's device,
 * inode, size, modification or change time differs from when it was last hashed. Any write
 * moves the change time, and only the kernel sets it, so an unchanged digest needs a file
 * rewritten in place with all five preserved. A digest is reused only for a file that held
 * still while it was hashed and whose times are older than the coarsest timestamp, so a
 * second write in the same tick cannot hide behind the first.
 *
 * With a memory, settled digests are kept across restarts under the same rule, so a start does
 * not hash a large agent again (Antigravity's install is hundreds of megabytes). The memory sits
 * beside the inventory, whose approved digests it is checked against: whoever can rewrite it
 * can already rewrite those.
 */
export class ExecutableDigests {
  #known = new Map<string, { file: string; digest: string }>();
  #now: () => number;
  #memory: DigestMemory | undefined;
  #saving: Promise<void> = Promise.resolve();
  constructor(now: () => number = Date.now, memory?: DigestMemory) {
    this.#now = now;
    this.#memory = memory;
  }
  /** Reads back what an earlier run settled; anything unreadable is forgotten, not fatal. */
  async recall(): Promise<void> {
    const stored = RememberedDigests.safeParse(await this.#memory?.load().catch(() => undefined));
    if (!stored.success) return;
    for (const { path, file, digest } of stored.data)
      if (!this.#known.has(path)) this.#known.set(path, { file, digest });
  }
  async digest(path: string): Promise<string> {
    const before = await statFile(path);
    const file = fileIdentity(before);
    const known = this.#known.get(path);
    if (known?.file === file) return known.digest;
    this.#known.delete(path);
    const started = BigInt(Math.floor(this.#now()));
    const digest = await executableDigest(path);
    const settled = (time: bigint) => time / 1_000_000n + timestampSlackMs < started;
    if (
      fileIdentity(await statFile(path)) === file &&
      settled(before.mtimeNs) &&
      settled(before.ctimeNs)
    ) {
      if (this.#known.size >= 256) this.#known.clear();
      this.#known.set(path, { file, digest });
      this.#remember();
    }
    return digest;
  }
  /** One write at a time, each of everything known then. A failed write costs a hash next start. */
  #remember(): void {
    const memory = this.#memory;
    if (!memory) return;
    this.#saving = this.#saving.then(() =>
      memory
        .save([...this.#known].map(([path, { file, digest }]) => ({ path, file, digest })))
        .catch(() => {}),
    );
  }
  /** Resolves once every digest settled so far is written. */
  saved(): Promise<void> {
    return this.#saving;
  }
}
/** The approved artifact a launch revalidates: the script behind a Windows node launch. */
function installationArtifact(entry: Pick<LocalInstallation, "command" | "args">): string {
  const [script] = entry.args;
  if (
    script !== undefined &&
    isAbsolute(script) &&
    /\.[cm]?js$/i.test(script) &&
    /^node(\.exe)?$/i.test(basename(entry.command))
  )
    return script;
  return entry.command;
}
export async function bindLocal(
  input: LocalBinding,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<LocalInstallation> {
  const command = await findExecutable(input.command, environment, platform);
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
  // A shebang cannot launch on Windows, so a JS entrypoint runs as `node <script>`.
  let launch = path;
  let launchArgs = [...input.args];
  if (platform === "win32" && /\.[cm]?js$/i.test(path)) {
    const node = await findExecutable("node", environment, platform);
    if (!node) throw new Error("Node unavailable for Windows script entrypoint");
    launch = await realpath(node);
    launchArgs = [path, ...launchArgs];
  }
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
    command: launch,
    args: launchArgs,
    env,
    executableDigest: await executableDigest(
      installationArtifact({ command: launch, args: launchArgs }),
    ),
    ...(bridgeCommand
      ? { bridgeCommand, bridgeDigest: await executableDigest(bridgeCommand) }
      : {}),
  });
}
export class LocalInventory {
  #entries = new Map<string, LocalInstallation>();
  /** Installations whose files changed since approval, by installation id, until approved. */
  #pending = new Map<string, RegistryPendingUpdate>();
  #digests: ExecutableDigests;
  #now: () => number;
  constructor(
    entries: readonly LocalInstallation[] = [],
    digests: ExecutableDigests = new ExecutableDigests(),
    now: () => number = Date.now,
  ) {
    this.#digests = digests;
    this.#now = now;
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
  /** Installations that changed since approval and wait for the person (ADR 0044 amendment). */
  pending(): RegistryPendingUpdate[] {
    return [...this.#pending.values()].map((value) => structuredClone(value));
  }
  has(identity: AcpIdentity): boolean {
    const entry = this.#entries.get(identity.installationId);
    return (
      !!entry &&
      entry.metadata.acpAgentId === identity.acpAgentId &&
      entry.metadata.instanceId === identity.instanceId
    );
  }
  #entry(input: AcpIdentity): LocalInstallation {
    const identity = AcpIdentity.parse(input);
    const entry = this.#entries.get(identity.installationId);
    if (!entry || !this.has(identity)) throw new Error("Approved ACP installation unavailable");
    return entry;
  }
  /** The digests on disk now, hashed without running anything. */
  async #observe(entry: LocalInstallation): Promise<Observed> {
    const agent = await this.#digests.digest(installationArtifact(entry));
    if (!entry.bridgeCommand) return { executableDigest: agent };
    const bridgeDigest = await this.#digests.digest(entry.bridgeCommand).catch(() => {
      throw new Error("Native bridge CLI changed or unavailable");
    });
    return { executableDigest: agent, bridgeDigest };
  }
  /** Records whether `entry`'s files still match its approval; true when they do. */
  #check(entry: LocalInstallation, observed: Observed): boolean {
    const key = entry.metadata.installationId;
    const pending = pendingUpdate(entry, observed, this.#now());
    if (!pending) {
      this.#pending.delete(key);
      return true;
    }
    const known = this.#pending.get(key);
    // The first sighting of these files keeps its time.
    if (
      known?.executableDigest !== pending.executableDigest ||
      known.bridgeDigest !== pending.bridgeDigest
    )
      this.#pending.set(key, pending);
    return false;
  }
  /**
   * Checks every installation against its approval without running anything, so the person
   * sees an update waiting before a thread needs it. A file that can't be read is skipped.
   */
  async review(): Promise<void> {
    for (const entry of this.#entries.values()) {
      const observed = await this.#observe(entry).catch(() => undefined);
      if (observed && this.#entries.get(entry.metadata.installationId) === entry)
        this.#check(entry, observed);
    }
  }
  /**
   * The installation approved for its changed files, for the same identity, not yet stored:
   * the caller persists it, then `replace`s. Only the person's approval reaches this.
   */
  async approved(identity: AcpIdentity, approval: UpdateApproval): Promise<LocalInstallation> {
    const entry = this.#entry(identity);
    const observed = await this.#observe(entry);
    return LocalInstallation.parse(approveUpdate(entry, approval, observed, this.#now()));
  }
  /** Stores an approved update of an installation already here, under the same identity. */
  replace(input: LocalInstallation): void {
    const entry = LocalInstallation.parse(input);
    this.#entry(entry.metadata);
    this.#entries.set(entry.metadata.installationId, entry);
    this.#pending.delete(entry.metadata.installationId);
  }
  async resolve(input: AcpIdentity, environment: NodeJS.ProcessEnv): Promise<LaunchPlan> {
    const identity = AcpIdentity.parse(input);
    const entry = this.#entry(identity);
    const bridgeVariable =
      identity.acpAgentId === "official:claude-acp"
        ? "CLAUDE_CODE_EXECUTABLE"
        : identity.acpAgentId === "official:codex-acp"
          ? "CODEX_PATH"
          : undefined;
    if (bridgeVariable && !entry.bridgeCommand)
      throw new Error("Native bridge CLI changed or unavailable");
    // A changed file never runs until the person approves the update (ADR 0044).
    if (!this.#check(entry, await this.#observe(entry))) throw new UpdateApprovalRequired(identity);
    // A reviewed agent older than ace's floor for it is refused before it launches. Agents
    // without a reviewed profile are admitted by ACP protocol version at initialize.
    const cli = acpAgentCli(identity.acpAgentId);
    if (cli) requireMinimum(cli, entry.metadata.version);
    const profile = identity.acpAgentId.startsWith("official:")
      ? profileFor(identity.acpAgentId.slice(9), entry.metadata.version)
      : undefined;
    const env = { ...environment, ...entry.env };
    if (bridgeVariable && entry.bridgeCommand) env[bridgeVariable] = entry.bridgeCommand;
    return Object.freeze({
      identity: Object.freeze(identity),
      version: entry.metadata.version,
      command: entry.command,
      args: Object.freeze([...entry.args]),
      env: Object.freeze(env),
      ...(profile ? { profile: profile.profile, profileFit: profile.fit } : {}),
    });
  }
}
