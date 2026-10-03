import { matchProfile } from "./profiles.ts";
import { readBoundedJson } from "./files.ts";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, open, stat, chmod, readdir, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { z } from "zod";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { extractTar, extractZip } from "./archives.ts";
import { contained, type InstallPlan } from "./plans.ts";
import { bindLocal, executableDigest, type LocalInstallation } from "./inventory.ts";
const PackageManifest = z.object({
  name: z.string(),
  version: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});
export type InstallRuntime = {
  fetch?: typeof fetch;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  env: NodeJS.ProcessEnv;
  onProgress?(phase: "download" | "extract" | "package_manager", receivedBytes: number): void;
};
async function download(
  plan: InstallPlan,
  path: string,
  signal: AbortSignal,
  request: typeof fetch,
  progress: InstallRuntime["onProgress"],
): Promise<void> {
  const response = await request(plan.archive ?? "", { signal, redirect: "error" });
  if (!response.ok || !response.body) throw new Error("Artifact download failed");
  const reader = response.body.getReader();
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 128 * 1024 * 1024) throw new Error("Artifact download exceeds budget");
      progress?.("download", bytes);
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (plan.sha256 && hash.digest("hex") !== plan.sha256)
      throw new Error("Artifact checksum mismatch");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close();
  }
}
async function runManager(
  plan: InstallPlan,
  stage: string,
  signal: AbortSignal,
  runtime: InstallRuntime,
): Promise<void> {
  if (!plan.command) throw new Error("Package manager unavailable");
  if (plan.managerDigest && (await executableDigest(plan.command)) !== plan.managerDigest)
    throw new Error("Selected package manager changed");
  const args = [...plan.args];
  const proc = (runtime.spawn ?? spawnSupervised)({
    command: plan.command,
    args,
    cwd: stage,
    env: {
      ...runtime.env,
      ...(plan.preview.runtime === "uv"
        ? { UV_TOOL_DIR: join(stage, "tools"), UV_TOOL_BIN_DIR: join(stage, "bin") }
        : {}),
    },
    maxOutputBytes: 4 * 1024 * 1024,
    name: "acp-install",
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const exit = await proc.exited;
    signal.throwIfAborted();
    if (exit.code !== 0 || exit.reason === "output-limit")
      throw new Error("Package installation failed");
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}
async function packageEntrypoint(plan: InstallPlan, stage: string): Promise<string> {
  if (plan.preview.runtime === "uv") {
    const names = await readdir(join(stage, "bin"));
    if (names.length !== 1 || !names[0])
      throw new Error("Ambiguous Python entrypoint; explicit local binding required");
    return join("bin", names[0]);
  }
  const spec = plan.agent.distribution.npx?.package ?? "";
  const name = spec.slice(0, spec.lastIndexOf("@"));
  const root = contained(join(stage, "node_modules"), name);
  const manifest = PackageManifest.parse(await readBoundedJson(join(root, "package.json"), 65536));
  if (manifest.name !== name || manifest.version !== plan.preview.version)
    throw new Error("Installed package identity differs from plan");
  const profile = plan.preview.acpAgentId.startsWith("official:")
    ? matchProfile(plan.agent.id, plan.preview.version)
    : undefined;
  const preferred =
    typeof manifest.bin !== "string" && profile ? manifest.bin[profile.command] : undefined;
  const bins = preferred
    ? [preferred]
    : typeof manifest.bin === "string"
      ? [manifest.bin]
      : [...new Set(Object.values(manifest.bin))];
  if (bins.length !== 1 || !bins[0])
    throw new Error("Ambiguous package entrypoint; explicit local binding required");
  return relative(stage, contained(root, bins[0]));
}
async function packageEvidence(plan: InstallPlan, root: string) {
  if (plan.preview.runtime === "binary") return undefined;
  const spec = plan.agent.distribution.npx?.package ?? plan.agent.distribution.uvx?.package ?? "";
  let integrity: string | undefined;
  if (plan.preview.runtime === "npm") {
    const lock = z
      .object({ packages: z.record(z.string(), z.unknown()) })
      .parse(await readBoundedJson(join(root, "package-lock.json"), 4 * 1024 * 1024));
    const name = spec.slice(0, spec.lastIndexOf("@"));
    const entry = z
      .object({
        version: z.literal(plan.preview.version),
        integrity: z
          .string()
          .max(1024)
          .regex(/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/),
      })
      .parse(lock.packages[`node_modules/${name}`]);
    integrity = entry.integrity;
  }
  return { command: plan.command ?? "", package: spec, ...(integrity ? { integrity } : {}) };
}
export async function executeInstall(
  plan: InstallPlan,
  signal: AbortSignal,
  runtime: InstallRuntime,
): Promise<LocalInstallation> {
  signal.throwIfAborted();
  const destination = plan.preview.destination;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // A digest directory is never overwritten. Reinstall is a separately approved local operation.
  try {
    await stat(destination);
    throw new Error("Installation already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(destination, { mode: 0o700 });
  const stage = await realpath(destination);
  let published = false;
  try {
    let entrypoint: string;
    if (plan.preview.runtime === "binary") {
      const artifact = join(stage, ".artifact");
      runtime.onProgress?.("download", 0);
      await download(plan, artifact, signal, runtime.fetch ?? fetch, runtime.onProgress);
      runtime.onProgress?.("extract", 0);
      const pathname = new URL(plan.archive ?? "").pathname.toLowerCase();
      const files = join(stage, "files");
      await mkdir(files, { mode: 0o700 });
      entrypoint = join("files", plan.entrypoint ?? "");
      if (/\.(tar\.gz|tgz)$/.test(pathname)) await extractTar(artifact, files, signal);
      else if (pathname.endsWith(".zip")) await extractZip(artifact, files, signal);
      else {
        const target = contained(files, plan.entrypoint ?? "");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(artifact, target);
      }
      await rm(artifact, { force: true });
    } else {
      runtime.onProgress?.("package_manager", 0);
      await runManager(plan, stage, signal, runtime);
      entrypoint = await packageEntrypoint(plan, stage);
    }
    const command = contained(stage, entrypoint);
    const resolved = await realpath(command);
    if (!resolved.startsWith(stage + sep) || !(await stat(resolved)).isFile())
      throw new Error("Installed entrypoint escapes artifact");
    await chmod(resolved, 0o700);
    signal.throwIfAborted();
    // uv environments contain absolute paths; their private root becomes visible only in inventory.
    published = true;
    const installation = await bindLocal(
      {
        acpAgentId: plan.preview.acpAgentId,
        installationId: plan.preview.digest,
        instanceId: `${plan.preview.digest}:default`,
        version: plan.preview.version,
        command: contained(destination, entrypoint),
        args: plan.launchArgs,
        env: plan.env,
        source: plan.preview.source,
      },
      runtime.env,
    );
    const packageManager = await packageEvidence(plan, destination);
    return {
      ...installation,
      metadata: {
        ...installation.metadata,
        ...(packageManager ? { packageManager } : {}),
        evidence: plan.sha256
          ? "sha256"
          : plan.preview.runtime === "binary"
            ? "unsigned_https"
            : "package_manager",
      },
    };
  } catch (error) {
    if (published) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}
