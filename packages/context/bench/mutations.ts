import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const mutations = [
  {
    name: "Bypass workspace confinement",
    file: "git-workspace.ts",
    before: "private async checked(path: string): Promise<string> {",
    after: "private async checked(path: string): Promise<string> { return resolve(this.root,path);",
    test: "mentions.test.ts",
    behavior: "absolute paths and parent traversal",
  },
  {
    name: "Accept Git ignored paths",
    file: "git-workspace.ts",
    before: "ignored.code !== 0",
    after: "true",
    test: "mentions.test.ts",
    behavior: "tracked files newly ignored",
  },
  {
    name: "Decode NUL bytes as text",
    file: "mentions.ts",
    before: 'if (bytes.includes(0)) throw new Error("Binary");',
    after: 'if (false) throw new Error("Binary");',
    test: "mentions.test.ts",
    behavior: "binary and invalid UTF-8",
  },
  {
    name: "Drop file-cap truncation markers",
    file: "mentions.ts",
    before: "let selectedTruncated = more;",
    after: "let selectedTruncated = false;",
    test: "mentions.test.ts",
    behavior: "file caps mark truncation",
  },
  {
    name: "Shift inclusive line ranges",
    file: "mentions.ts",
    before: "selected.slice(lines.start - 1, lines.end)",
    after: "selected.slice(lines.start, lines.end)",
    test: "mentions.test.ts",
    behavior: "inclusive line ranges",
  },
  {
    name: "Bypass per-thread byte quota",
    file: "upload-store.ts",
    before: "thread.bytes + op.bytes <= this.limits.threadBytes",
    after: "true",
    test: "uploads.test.ts",
    behavior: "thread quota counts",
  },
  {
    name: "Bypass global byte quota",
    file: "upload-store.ts",
    before:
      "global.bytes + op.bytes <= this.limits.globalBytes &&\n            occupied.bytes + op.bytes <= this.limits.globalBytes",
    after: "true",
    test: "uploads.test.ts",
    behavior: "global quota reserves",
  },
  {
    name: "Accept hash mismatches",
    file: "upload-store.ts",
    before: "inspected.sha256 === row.sha256",
    after: "true",
    test: "uploads.test.ts",
    behavior: "hash mismatches reject",
  },
  {
    name: "Bypass image pixel-area limit",
    file: "media.ts",
    before: "size.width * size.height <= limits.maxPixels",
    after: "true",
    test: "uploads.test.ts",
    behavior: "pixel area limits reject",
  },
  {
    name: "Ignore image magic bytes",
    file: "media.ts",
    before: 'return "image/png";',
    after: 'return "text/plain";',
    test: "uploads.test.ts",
    behavior: "magic-byte sniffing identifies",
  },
  {
    name: "Bypass GIF animation gates",
    file: "image-container.ts",
    before: "++frames === 1",
    after: "++frames > 0",
    test: "uploads.test.ts",
    behavior: "animated GIFs cannot",
    extra: {
      before: "frames === 1 && position === bytes",
      after: "frames > 0 && position === bytes",
    },
  },
  {
    name: "Remove PNG header checksum check",
    file: "image-container.ts",
    before: "crc(ihdr.subarray(0, 17)) === ihdr.readUInt32BE(17)",
    after: "true",
    test: "uploads.test.ts",
    behavior: "corrupt PNG header checksums",
  },
  {
    name: "Disable Codex image projection",
    file: "projection.ts",
    before:
      'if (capabilities.images.includes(a.mimeType)) return { type: "localImage", path: a.path };',
    after: 'if (false) return { type: "localImage", path: a.path };',
    test: "projection.test.ts",
    behavior: "Codex receives a daemon-local",
  },
  {
    name: "Collect referenced blobs",
    file: "maintenance.ts",
    before: "WHERE refs=0 AND NOT EXISTS",
    after: "WHERE refs>=0 AND NOT EXISTS",
    test: "uploads.test.ts",
    behavior: "collection removes only blobs",
  },
  {
    name: "Bypass occupied disk quota",
    file: "upload-store.ts",
    before: "occupied.bytes + op.bytes <= this.limits.globalBytes",
    after: "true",
    test: "uploads.test.ts",
    behavior: "global disk quota includes",
  },
  {
    name: "Allow another device to resume",
    file: "upload-store.ts",
    before: "row && row.device === device",
    after: "row",
    test: "uploads.test.ts",
    behavior: "uploads cannot be resumed",
  },
];
for (const mutation of mutations) {
  const path = join(root, "packages/context/src", mutation.file),
    source = await readFile(path, "utf8");
  if (!source.includes(mutation.before))
    throw new Error(`Mutation target missing: ${mutation.name}`);
  let output = "",
    failed = false;
  try {
    let changed = source.replace(mutation.before, mutation.after);
    if ("extra" in mutation && mutation.extra) {
      if (!changed.includes(mutation.extra.before))
        throw new Error(`Additional mutation target missing: ${mutation.name}`);
      changed = changed.replace(mutation.extra.before, mutation.extra.after);
    }
    await writeFile(path, changed);
    try {
      await run(
        "bun",
        ["run", "test", `packages/context/src/${mutation.test}`, "-t", mutation.behavior],
        { cwd: root, maxBuffer: 2 * 1024 * 1024 },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        "stderr" in error &&
        typeof error.stderr === "string"
      ) {
        output = error.stdout + error.stderr;
        failed = output.includes("AssertionError");
      } else throw error;
    }
  } finally {
    await writeFile(path, source);
  }
  if (!failed)
    throw new Error(`Mutation survived or did not fail an assertion: ${mutation.name}\n${output}`);
  process.stdout.write(`KILLED: ${mutation.name} -> ${mutation.behavior}\n`);
}
process.stdout.write(
  `${mutations.length} production mutations failed behavior assertions and were reverted.\n`,
);
