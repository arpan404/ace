import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
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
/** Copy only on first install. Runtime startup never rewrites a stable executable. */
/**
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
  const installed = join(root, "AceScreenHelper.app");
  try {
    const current = await manifest(join(root, "manifest.json"));
    if (current.sha256 !== expected.sha256 || current.plistSha256 !== expected.plistSha256)
      throw new Error(
        "Installed helper differs; stop ace and upgrade explicitly, never rewrite it at runtime",
      );
    return await verify(installed, current);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await verify(app, expected);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  // Creating the stable directory is the install lock. No temporary executable path.
  await mkdir(root, { mode: 0o700 });
  try {
    await cp(app, installed, { recursive: true, force: false, errorOnExist: true });
    const executable = await verify(installed, expected);
    // The manifest is the completion marker; another startup never executes a partial copy.
    await writeFile(join(root, "manifest.json"), JSON.stringify(expected), {
      flag: "wx",
      mode: 0o600,
    });
    return executable;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
