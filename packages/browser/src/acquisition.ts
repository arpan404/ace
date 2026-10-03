import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { BrowserDownloadProgress } from "@ace/protocol";
import { ChromiumArtifact, chromiumArtifact } from "./chromium-manifest.ts";
import { extractChromium } from "./archive.ts";

const Verified = z.object({
  checksum: z.string(),
  executableHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface ChromiumAcquisitionOptions {
  dataDir: string;
  signal?: AbortSignal;
  artifact?: ChromiumArtifact;
  fetch?: typeof fetch;
  progress?: (progress: BrowserDownloadProgress) => void;
}
async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new Error("Chromium executable size limit");
    digest.update(chunk);
  }
  return digest.digest("hex");
}
/** Versioned install, bounded streamed transfer, verification before extraction/publication. */
export async function acquireChromium(options: ChromiumAcquisitionOptions): Promise<string> {
  const artifact = ChromiumArtifact.parse(
    options.artifact ?? chromiumArtifact(process.platform, process.arch),
  );
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(600_000),
  ]);
  signal.throwIfAborted();
  const root = join(options.dataDir, "chromium");
  const final = join(root, `${artifact.version}-${artifact.checksum}`);
  const executable = resolve(final, artifact.executable);
  if (isAbsolute(artifact.executable) || !executable.startsWith(resolve(final) + sep))
    throw new Error("Invalid Chromium executable path");
  try {
    const marker = await open(join(final, "verified.json"), "r");
    let source: string;
    try {
      const bytes = Buffer.alloc(1025);
      const result = await marker.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 1024) throw new Error("Invalid Chromium verification marker");
      source = bytes.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await marker.close();
    }
    const verified = Verified.parse(JSON.parse(source));
    if (
      verified.checksum !== artifact.checksum ||
      (await hashFile(executable, signal)) !== verified.executableHash
    )
      throw new Error("Chromium cache checksum mismatch");
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    /* Missing, incomplete or modified installations are replaced below. */
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, ".download-"));
  const archive = join(stage, "chromium.zip"),
    expanded = join(stage, "expanded");
  let received = 0;
  const report = (phase: BrowserDownloadProgress["phase"], total?: number) =>
    options.progress?.({
      type: "browser.download.progress",
      version: artifact.version,
      phase,
      received,
      ...(total === undefined ? {} : { total }),
    });
  try {
    const response = await (options.fetch ?? fetch)(artifact.url, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Chromium download failed");
    const length = response.headers.get("content-length");
    const total = length === null ? undefined : Number(length);
    if (
      total !== undefined &&
      (!Number.isSafeInteger(total) || total < 0 || total > 512 * 1024 * 1024)
    ) {
      await response.body.cancel();
      throw new Error("Chromium archive size limit");
    }
    const digest = createHash("md5");
    let reported = -1024 * 1024;
    report("downloading", total);
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        received += chunk.length;
        if (received > 512 * 1024 * 1024) {
          next(new Error("Chromium archive size limit"));
          return;
        }
        digest.update(chunk);
        if (received - reported >= 1024 * 1024) {
          reported = received;
          report("downloading", total);
        }
        next(null, chunk);
      },
    });
    const body = response.body;
    async function* chunks() {
      const reader = body.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    await pipeline(
      Readable.from(chunks()),
      bound,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    report("verifying", total);
    if ((total !== undefined && received !== total) || digest.digest("hex") !== artifact.checksum)
      throw new Error("Chromium archive checksum mismatch");
    await mkdir(expanded, { mode: 0o700 });
    report("extracting", total);
    await extractChromium(archive, expanded, signal);
    const stagedExecutable = join(expanded, artifact.executable);
    await access(stagedExecutable, constants.X_OK);
    await writeFile(
      join(expanded, "verified.json"),
      JSON.stringify({
        checksum: artifact.checksum,
        executableHash: await hashFile(stagedExecutable, signal),
      }),
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    await rm(final, { recursive: true, force: true });
    await rename(expanded, final);
    report("ready", total);
    return executable;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
