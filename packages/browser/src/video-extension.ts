import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { videoExtensionFiles } from "./video-extension.gen.ts";

/**
 * The public half of the video extension's signing key (SubjectPublicKeyInfo, base64 DER). As
 * the manifest `key` it fixes the extension id, which Chrome's `--allowlisted-extension-id`
 * names so the extension may capture tabs without a user gesture (ADR 0088). The private half
 * was never kept.
 */
export const videoExtensionKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkr+lljUNPWjqx8vgEZa0HWwqEL8cT7vI/WQyUNE5qeBPfedDQIR0s+B9ok0Vkd+l33lKdPtpd2acRjqV/dl6He8mvO9ZhGyNCWmPhkHNKwD1z7V4hUF51P1YKx8U3NEItNiH7zPjBVlwNCxIAAjN9P6slawRIyN8BCjpebokRPuXY/joxexZLLZpZLXKMNozGKVWtAbL+uj1kxW+bZJhqOzOa8uXS3A6/a69dIV0Ay7FmUn5xLrXaH2gZDTdaYwAIYmT6k9OQ9eSgz7abR1pjTRDC6HuTWxcb2LRpaJXTKqKf6rBhuNIQbujufqtLe3m9wnvWChWqhZnukfdztF0RwIDAQAB";
/** Chrome's id for `videoExtensionKey`: the first 128 bits of its SHA-256, as letters a–p. */
export const videoExtensionId = "ldgefbphhfgphnecebnomhhopapknllk";

export function videoExtensionManifest() {
  return {
    manifest_version: 3,
    name: "ace video",
    version: "0.1.0",
    description: "Encodes ace's browser tabs as video for ace's own viewers.",
    key: videoExtensionKey,
    minimum_chrome_version: "125",
    permissions: ["tabCapture", "offscreen", "tabs"],
    background: { service_worker: "worker.js" },
  };
}

/**
 * Writes the unpacked extension to `directory` unless it already holds this exact build: a
 * running Chrome may have it loaded, and rewriting it would reload it under every viewer.
 */
export async function writeVideoExtension(directory: string): Promise<void> {
  const files: Record<string, string> = {
    "manifest.json": `${JSON.stringify(videoExtensionManifest(), null, 2)}\n`,
    ...videoExtensionFiles,
  };
  const current = await Promise.all(
    Object.entries(files).map(
      async ([name, contents]) =>
        (await readFile(join(directory, name), "utf8").catch(() => undefined)) === contents,
    ),
  );
  if (current.every(Boolean)) return;
  const staging = `${directory}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(staging, name), contents);
  await rm(directory, { recursive: true, force: true });
  await rename(staging, directory);
}
