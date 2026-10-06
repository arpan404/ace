import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Transform, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReleaseManifest } from "@ace/protocol";
import { createGunzip } from "node:zlib";
export function verifyManifest(
  bytes: Uint8Array,
  signature: string,
  publicKey: string,
): ReleaseManifest {
  if (bytes.length > 16 * 1024 || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
    throw new Error("Invalid release signature envelope");
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, key, Buffer.from(signature, "base64"))
  )
    throw new Error("Release signature rejected");
  return ReleaseManifest.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
export async function downloadArchive(
  response: Response,
  path: string,
  manifest: ReleaseManifest,
): Promise<void> {
  if (!response.ok || !response.body) throw new Error("Release download failed");
  let bytes = 0;
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > manifest.bytes) {
        callback(new Error("Release size exceeded"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.from(responseChunks(response.body)),
    meter,
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256)
    throw new Error("Release checksum rejected");
}
export async function unpackArchive(file: string, directory: string): Promise<void> {
  const { Parser, extract } = await import("tar");
  let entries = 0,
    total = 0;
  let invalid = false;
  const seen = new Set<string>();
  const parser = new Parser({
    maxMetaEntrySize: 16 * 1024,
    onReadEntry(entry) {
      const name = entry.path.replace(/\/$/, "");
      const parts = name.split("/");
      if (
        ++entries > 2048 ||
        parts.some((p) => !p || p === "." || p === "..") ||
        name.startsWith("/") ||
        name.includes("\\") ||
        seen.has(name) ||
        !["File", "Directory"].includes(entry.type)
      )
        invalid = true;
      if (seen.size < 2048) seen.add(name);
      total += entry.size;
      if (total > 512 * 1024 * 1024) invalid = true;
      entry.resume();
      if (invalid) parser.abort(new Error("Unsafe release archive"));
    },
  });
  let expanded = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      callback(
        expanded > 512 * 1024 * 1024 ? new Error("Expanded release too large") : null,
        chunk,
      );
    },
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (parser.write(chunk)) callback();
      else parser.once("drain", callback);
    },
    final(callback) {
      parser.once("end", callback);
      parser.end();
    },
  });
  parser.on("error", (error: Error) => sink.destroy(error));
  await pipeline(createReadStream(file), createGunzip(), cap, sink, {
    signal: AbortSignal.timeout(120_000),
  });
  if (invalid) throw new Error("Unsafe release archive");
  await mkdir(directory, { mode: 0o700 });
  await extract({ file, cwd: directory, strict: true, preserveOwner: false, noChmod: false });
}

async function* responseChunks(body: NonNullable<Response["body"]>) {
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
