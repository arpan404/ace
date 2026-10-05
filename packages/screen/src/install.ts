import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
const Manifest = z.object({
  bundleId: z.literal("dev.ace.screen-helper"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  plistSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
async function manifest(path: string) {
  if (!(await lstat(path)).isFile()) throw new Error("Invalid helper manifest file");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 4096) throw new Error("Helper manifest exceeds limit");
    return Manifest.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally {
    await file.close();
  }
}
async function digest(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("Invalid helper file");
  const hash = createHash("sha256");
  let length = 0;
  for await (const bytes of createReadStream(path)) {
    if (!Buffer.isBuffer(bytes)) throw new Error("Invalid helper bytes");
    length += bytes.length;
    if (length > 256 * 1024 * 1024) throw new Error("Helper file exceeds limit");
    hash.update(bytes);
  }
  return hash.digest("hex");
}
async function verify(app: string, expected: z.infer<typeof Manifest>): Promise<string> {
  const executable = join(app, "Contents/MacOS/ace-screen-helper");
  if (
    (await digest(executable)) !== expected.sha256 ||
    (await digest(join(app, "Contents/Info.plist"))) !== expected.plistSha256
  )
    throw new Error("Helper bundle hash mismatch");
  return executable;
}
/**
 * Install a verified helper bundle once per version, and return its executable.
 *
 * Runtime never rewrites an installed executable: a different version goes into a directory
 * named for its executable and Info.plist hashes beside the earlier ones
 * (`screen-helper/<version>/`), so a running helper is
 * never replaced and a new app build still finds its own helper. macOS keys privacy grants to
 * the helper's signing identity, not its path, so a signed upgrade keeps them.
 *
 * `manifestPath` defaults to `manifest.json` beside the app. A host app that ships the helper
 * in `Contents/Helpers` keeps the manifest in its own sealed resources instead, because
 * codesign rejects non-code files in `Contents/Helpers`.
 */
export async function installScreenHelper(
  source: string,
  dataDirectory: string,
  manifestPath?: string,
): Promise<string> {
  const resolved = await realpath(source);
  const app = resolved.endsWith(".app") ? resolved : dirname(dirname(dirname(resolved)));
  if (!app.endsWith(".app"))
    throw new Error(
      "V2 requires an app bundle; use explicit legacy transport for a standalone v1 helper",
    );
  const expected = await manifest(manifestPath ?? join(dirname(app), "manifest.json"));
  const root = join(dataDirectory, "screen-helper");
  // The first layout kept a single version directly in the root; reuse it when it matches.
  const legacy = await installed(root, expected);
  if (legacy) return legacy;
  // Every installed input names the version, so a changed Info.plist is a new version too.
  const version = createHash("sha256")
    .update(`${expected.sha256}:${expected.plistSha256}`)
    .digest("hex")
    .slice(0, 24);
  const versioned = join(root, version);
  const existing = await installed(versioned, expected);
  if (existing) return existing;
  await verify(app, expected);
  await withinBundleBudget(app);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Copy into a private staging directory, then rename it into place in one step: a version
  // directory only ever exists complete, so nothing completed is deleted or overwritten, and
  // the staged copy is never executed.
  const staging = await mkdtemp(join(root, `.${version}-`));
  try {
    await pruneAbandonedCopies(root, staging);
    const destination = join(staging, "AceScreenHelper.app");
    await cp(app, destination, { recursive: true, force: false, errorOnExist: true });
    await verify(destination, expected);
    await writeFile(join(staging, "manifest.json"), JSON.stringify(expected), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(staging, versioned);
    } catch (error) {
      // Another start installed the same version first: use its copy if it verifies.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const winner = await installed(versioned, expected);
      if (!winner) throw error;
      return winner;
    }
    return join(versioned, "AceScreenHelper.app/Contents/MacOS/ace-screen-helper");
  } finally {
    // Only the staging copy: gone already after a successful rename.
    await rm(staging, { recursive: true, force: true });
  }
}

const maxBundleBytes = 256 * 1024 * 1024;
const maxBundleEntries = 4096;
/** A helper bundle is copied once per version; refuse one far larger than the real helper. */
async function withinBundleBudget(app: string): Promise<void> {
  let bytes = 0;
  const entries = await readdir(app, { recursive: true, withFileTypes: true });
  if (entries.length > maxBundleEntries) throw new Error("Helper bundle has too many files");
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    bytes += (await lstat(join(entry.parentPath, entry.name))).size;
    if (bytes > maxBundleBytes) throw new Error("Helper bundle exceeds size limit");
  }
}

/**
 * Staging copies left by a start that died mid-copy, an hour older than our own (the file
 * system's clock, so a concurrent start's copy is left alone). Never executed, so safe to remove.
 */
async function pruneAbandonedCopies(root: string, own: string): Promise<void> {
  const cutoff = (await lstat(own)).mtimeMs - 60 * 60 * 1000;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.[a-f0-9]{24}-/.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (path !== own && (await lstat(path)).mtimeMs < cutoff)
      await rm(path, { recursive: true, force: true });
  }
}

/** The executable installed in `directory` when its manifest names exactly this version. */
async function installed(
  directory: string,
  expected: z.infer<typeof Manifest>,
): Promise<string | undefined> {
  let current: z.infer<typeof Manifest>;
  try {
    current = await manifest(join(directory, "manifest.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (current.sha256 !== expected.sha256 || current.plistSha256 !== expected.plistSha256)
    return undefined;
  // Installed bytes must still match; tampering is an error, never a silent reinstall.
  return verify(join(directory, "AceScreenHelper.app"), current);
}
