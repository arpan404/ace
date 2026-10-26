import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";
import { pinnedServeSim } from "./serve-sim-version.ts";

/** One npm package tarball ace downloads, pinned by version and the registry's sha512. */
export interface NpmArtifact {
  name: string;
  version: string;
  url: string;
  integrity: string;
}

/**
 * The serve-sim ace runs, and `ws`, the one package its bundled script imports from outside.
 * Its native parts ship prebuilt (signed universal binaries), so nothing compiles here.
 */
export const serveSimArtifacts: { serveSim: NpmArtifact; ws: NpmArtifact } = {
  serveSim: {
    name: "serve-sim",
    version: pinnedServeSim,
    url: `https://registry.npmjs.org/serve-sim/-/serve-sim-${pinnedServeSim}.tgz`,
    integrity:
      "sha512-oWN0RJ11Vqnvr9irScNj847MsjusPzAS9YllcMsRh13Dq0feW+EUK0XEOKIJe7dsq0Wh7tHgXw449+BOzmRwCA==",
  },
  ws: {
    name: "ws",
    version: "8.22.0",
    url: "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
    integrity:
      "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==",
  },
};

/** A tarball larger than this is refused before it is read in full. */
const tarballLimit = 32 * 1024 * 1024;
const Marker = z.object({ serveSim: z.string(), ws: z.string() });

/** How to run serve-sim: ace's Node with its script first, then serve-sim's own arguments. */
export interface ServeSimCommand {
  command: string;
  args: string[];
}

export interface ServeSimInstall {
  /** ace's tools directory, inside its home. */
  directory: string;
  /** The Node that runs serve-sim's script: the daemon's own. */
  node: string;
  /** The pinned packages; tests substitute their own. */
  artifacts?: { serveSim: NpmArtifact; ws: NpmArtifact };
}

const installDirectory = (options: ServeSimInstall, artifacts: { serveSim: NpmArtifact }) =>
  join(options.directory, `serve-sim-${artifacts.serveSim.version}`);

/** ace's own serve-sim, when an install of the pinned packages is in place. */
export async function managedServeSim(
  options: ServeSimInstall,
): Promise<ServeSimCommand | undefined> {
  const artifacts = options.artifacts ?? serveSimArtifacts;
  const root = installDirectory(options, artifacts);
  try {
    const marker = Marker.parse(
      JSON.parse(await readFile(join(root, ".ace-install.json"), "utf8")),
    );
    if (marker.serveSim !== artifacts.serveSim.integrity || marker.ws !== artifacts.ws.integrity)
      return undefined;
    const script = join(root, "dist", "serve-sim.js");
    if (!(await stat(script)).isFile()) return undefined;
    return { command: options.node, args: [script] };
  } catch {
    return undefined;
  }
}

const unavailable = (message: string) =>
  new DeviceError(
    "tool_missing",
    message,
    "Check the network and download the device tools again from Devices.",
  );

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function download(
  artifact: NpmArtifact,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetcher(artifact.url, { redirect: "follow", ...(signal ? { signal } : {}) });
  } catch (error) {
    signal?.throwIfAborted();
    throw unavailable(`${artifact.name} download failed: ${String(error)}`);
  }
  if (!response.ok || !response.body)
    throw unavailable(`${artifact.name} download failed with HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > tarballLimit) throw unavailable(`${artifact.name} download is too large`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  if (integrityOf(bytes) !== artifact.integrity)
    throw unavailable(`${artifact.name} ${artifact.version} failed its checksum`);
  return bytes;
}

async function untar(
  runtime: Pick<DeviceRuntime, "spawn">,
  env: NodeJS.ProcessEnv,
  archive: string,
  into: string,
  strip: boolean,
): Promise<void> {
  const child = runtime.spawn({
    command: "/usr/bin/tar",
    args: ["-xzf", archive, "-C", into, ...(strip ? ["--strip-components", "1"] : [])],
    env,
    name: "device-tools-untar",
  });
  child.stdout.resume();
  child.stderr.resume();
  const exit = await child.exited;
  if (exit.code !== 0) throw unavailable(`Couldn't unpack ${archive}`);
}

/**
 * Downloads the pinned serve-sim and `ws`, checks both against their registry checksums and
 * unpacks them into ace's tools directory, all or nothing: a half-finished install is never
 * found, and an install already in place is reused.
 */
export async function installServeSim(
  options: ServeSimInstall & {
    runtime: Pick<DeviceRuntime, "spawn" | "id">;
    fetch: typeof fetch;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<ServeSimCommand> {
  const existing = await managedServeSim(options);
  if (existing) return existing;
  const artifacts = options.artifacts ?? serveSimArtifacts;
  const [serveSim, ws] = await Promise.all([
    download(artifacts.serveSim, options.fetch, options.signal),
    download(artifacts.ws, options.fetch, options.signal),
  ]);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const staging = join(options.directory, `.serve-sim-${options.runtime.id()}.partial`);
  try {
    const modules = join(staging, "package", "node_modules", "ws");
    await mkdir(modules, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, "serve-sim.tgz"), serveSim, { mode: 0o600 });
    await writeFile(join(staging, "ws.tgz"), ws, { mode: 0o600 });
    // npm tarballs hold everything under `package/`.
    await untar(options.runtime, options.env, join(staging, "serve-sim.tgz"), staging, false);
    await untar(options.runtime, options.env, join(staging, "ws.tgz"), modules, true);
    await writeFile(
      join(staging, "package", ".ace-install.json"),
      JSON.stringify({ serveSim: artifacts.serveSim.integrity, ws: artifacts.ws.integrity }),
      { mode: 0o600 },
    );
    const root = installDirectory(options, artifacts);
    await rm(root, { recursive: true, force: true });
    try {
      await rename(join(staging, "package"), root);
    } catch (error) {
      // Another install finished first with the same pinned packages.
      if (!(await managedServeSim(options))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const installed = await managedServeSim(options);
  if (!installed) throw unavailable("serve-sim didn't install");
  return installed;
}
