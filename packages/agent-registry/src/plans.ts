import { join, isAbsolute, resolve, sep } from "node:path";
import { RegistryInstallPlan } from "@ace/protocol";
import { digest } from "./cache.ts";
import type { AgentEntry } from "./decode.ts";
export class InstallPlanError extends Error {}
export type InstallPlan = Readonly<{
  preview: RegistryInstallPlan;
  catalogDigest: string;
  agent: AgentEntry;
  command?: string;
  managerDigest?: string;
  args: readonly string[];
  launchArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  archive?: string;
  sha256?: string;
  entrypoint?: string;
}>;
export type PlanOptions = {
  acpAgentId: string;
  source: string;
  catalogDigest: string;
  agent: AgentEntry;
  target: string;
  root: string;
  runtime: "binary" | "npm" | "uv";
  manager?: string;
  managerDigest?: string;
};
export function safeRelative(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path)
  )
    throw new InstallPlanError("Unsafe artifact path");
  const stripped = path.replace(/^\.\//, "");
  if (stripped.split("/").some((part) => part === ".." || part === ""))
    throw new InstallPlanError("Unsafe artifact path");
  return stripped;
}
export function contained(root: string, path: string): string {
  const result = resolve(root, safeRelative(path));
  if (!result.startsWith(resolve(root) + sep))
    throw new InstallPlanError("Artifact path escapes destination");
  return result;
}
export function buildInstallPlan(options: PlanOptions): InstallPlan {
  const { agent, runtime, manager } = options;
  let args: string[] = [];
  let launchArgs: string[];
  let env: Record<string, string>;
  let archive: string | undefined;
  let sha256: string | undefined;
  let entrypoint: string | undefined;
  let verification: RegistryInstallPlan["verification"];
  let packageSpec: string | undefined;
  if (runtime === "binary") {
    const distribution = agent.distribution.binary?.[options.target];
    if (!distribution) throw new InstallPlanError("Binary target unavailable");
    const url = new URL(distribution.archive);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new InstallPlanError("Artifact must use HTTPS");
    if (/\.(dmg|pkg|deb|rpm|msi|appimage|tbz2|bz2)$/i.test(url.pathname))
      throw new InstallPlanError("Unsupported archive format");
    archive = distribution.archive;
    sha256 = distribution.sha256?.toLowerCase();
    entrypoint = safeRelative(distribution.cmd);
    launchArgs = [...distribution.args];
    env = { ...distribution.env };
    verification = sha256 ? "sha256" : "unsigned_https";
  } else {
    if (!manager || !isAbsolute(manager))
      throw new InstallPlanError("Select a local package manager");
    const distribution = runtime === "npm" ? agent.distribution.npx : agent.distribution.uvx;
    if (!distribution) throw new InstallPlanError("Package distribution unavailable");
    packageSpec = distribution.package;
    // Only exact upstream versions can form an install intent. Tags, URLs and ranges need a new plan.
    const valid =
      runtime === "npm"
        ? /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+@\d+\.\d+\.\d+$/
        : /^[a-zA-Z0-9._-]+==\d+\.\d+\.\d+$/;
    if (runtime === "uv" && /^[a-zA-Z0-9._-]+$/.test(packageSpec))
      packageSpec = `${packageSpec}==${agent.version}`;
    if (
      !valid.test(packageSpec) ||
      !packageSpec.endsWith(`${runtime === "npm" ? "@" : "=="}${agent.version}`)
    )
      throw new InstallPlanError("Distribution version is not pinned to agent version");
    launchArgs = [...distribution.args];
    env = { ...distribution.env };
    verification = "package_manager";
  }
  if (
    Object.keys(env).some((key) =>
      /token|key|secret|password|credential|authorization|home|config_dir/i.test(key),
    )
  )
    throw new InstallPlanError("Registry cannot set private account environment");
  const seed = { ...options, manager, packageSpec, archive, sha256, entrypoint, launchArgs, env };
  const planDigest = digest(JSON.stringify(seed));
  const destination = join(options.root, planDigest);
  if (runtime === "npm")
    args = [
      "install",
      "--prefix",
      destination,
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--",
      packageSpec ?? "",
    ];
  if (runtime === "uv") args = ["tool", "install", "--no-progress", "--", packageSpec ?? ""];
  const preview = RegistryInstallPlan.parse({
    digest: planDigest,
    acpAgentId: options.acpAgentId,
    version: agent.version,
    source: options.source,
    publisher: agent.authors,
    runtime,
    target: options.target,
    destination,
    argv:
      runtime === "binary" ? [archive ?? "", entrypoint ?? "", ...launchArgs] : [manager, ...args],
    verification,
  });
  return Object.freeze({
    preview: Object.freeze(preview),
    catalogDigest: options.catalogDigest,
    agent,
    ...(manager ? { command: manager } : {}),
    ...(options.managerDigest ? { managerDigest: options.managerDigest } : {}),
    args: Object.freeze(args),
    launchArgs: Object.freeze(launchArgs),
    env: Object.freeze(env),
    ...(archive ? { archive } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(entrypoint ? { entrypoint } : {}),
  });
}
