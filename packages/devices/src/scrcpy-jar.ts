import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceError } from "./sdk.ts";

/**
 * The upstream scrcpy server ace speaks to. Client and server must be the same release, so the
 * version, size and SHA-256 (from the release's SHA256SUMS.txt) are pinned together.
 */
export const scrcpyRelease = {
  version: "5.0.1",
  bytes: 733_930,
  sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",
  url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
} as const;
export type ScrcpyRelease = { version: string; bytes: number; sha256: string; url: string };

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function verified(path: string, sha256: string): Promise<boolean> {
  try {
    return digest(await readFile(path)) === sha256;
  } catch {
    return false;
  }
}
const unavailable = (message: string) =>
  new DeviceError(
    "tool_missing",
    message,
    "ace downloads scrcpy-server on first use. Check the network, or set ACE_SCRCPY_SERVER to a verified copy.",
  );

/**
 * The pinned server already in place (`ACE_SCRCPY_SERVER`, or ace's downloaded copy), verified
 * by checksum; undefined when it still has to be downloaded.
 */
export async function installedScrcpyJar(options: {
  directory: string | undefined;
  env: NodeJS.ProcessEnv;
  release?: ScrcpyRelease;
}): Promise<string | undefined> {
  const release = options.release ?? scrcpyRelease;
  const explicit = options.env["ACE_SCRCPY_SERVER"];
  if (explicit) {
    if (await verified(explicit, release.sha256)) return explicit;
    throw unavailable(`ACE_SCRCPY_SERVER is not scrcpy-server v${release.version}`);
  }
  if (!options.directory) return undefined;
  const path = join(options.directory, `scrcpy-server-v${release.version}`);
  return (await verified(path, release.sha256)) ? path : undefined;
}

/**
 * A local copy of the pinned server, verified by checksum. `ACE_SCRCPY_SERVER` names one
 * explicitly; otherwise it is downloaded once into `directory` (ace's home) and reused.
 */
export async function scrcpyServerJar(options: {
  directory: string | undefined;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  id(): string;
  signal?: AbortSignal;
  /** The pinned release; tests substitute their own. */
  release?: ScrcpyRelease;
}): Promise<string> {
  const release = options.release ?? scrcpyRelease;
  const explicit = options.env["ACE_SCRCPY_SERVER"];
  if (explicit) {
    if (await verified(explicit, release.sha256)) return explicit;
    throw unavailable(`ACE_SCRCPY_SERVER is not scrcpy-server v${release.version}`);
  }
  if (!options.directory) throw unavailable("No directory for the scrcpy server");
  const path = join(options.directory, `scrcpy-server-v${release.version}`);
  if (await verified(path, release.sha256)) return path;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  let response: Response;
  try {
    response = await options.fetch(release.url, {
      redirect: "follow",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw unavailable(`scrcpy-server download failed: ${String(error)}`);
  }
  if (!response.ok || !response.body)
    throw unavailable(`scrcpy-server download failed with HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > release.bytes) throw unavailable("scrcpy-server download is too large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  if (digest(bytes) !== release.sha256)
    throw unavailable("scrcpy-server download failed its checksum");
  // Concurrent first uses each write their own file; the last rename wins with identical bytes.
  const partial = `${path}.${options.id()}.partial`;
  try {
    await writeFile(partial, bytes, { mode: 0o600 });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}
