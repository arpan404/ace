import { expect, test } from "vitest";
import { cachedToolFiles, type FileFacts, type FileSystem } from "./files.ts";

function fakeFs(files: Record<string, { text: string; mtimeMs: number }>) {
  const reads: string[] = [];
  const fs: FileSystem = {
    stat: async (path): Promise<FileFacts> => {
      const file = files[path];
      if (!file) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: Buffer.byteLength(file.text),
        mtimeMs: file.mtimeMs,
      };
    },
    readFile: async (path) => {
      reads.push(path);
      const file = files[path];
      if (!file) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return file.text;
    },
  };
  return { fs, reads };
}

test("a config file over the cap is refused as too large without being read", async () => {
  const { fs, reads } = fakeFs({ "/c.json": { text: "x".repeat(2048), mtimeMs: 1 } });
  await expect(cachedToolFiles(fs, 1024).readFile("/c.json")).rejects.toMatchObject({
    code: "EFBIG",
  });
  expect(reads).toEqual([]);
});

test("an unchanged config file is read once; a changed one is read again", async () => {
  const files = { "/c.json": { text: '{"a":1}', mtimeMs: 1 } };
  const { fs, reads } = fakeFs(files);
  const cached = cachedToolFiles(fs);
  expect(await cached.readFile("/c.json")).toBe('{"a":1}');
  expect(await cached.readFile("/c.json")).toBe('{"a":1}');
  expect(reads).toHaveLength(1);
  files["/c.json"] = { text: '{"a":2}', mtimeMs: 2 };
  expect(await cached.readFile("/c.json")).toBe('{"a":2}');
  expect(reads).toHaveLength(2);
});

test("an absent config file stays absent", async () => {
  const { fs } = fakeFs({});
  await expect(cachedToolFiles(fs).readFile("/none")).rejects.toMatchObject({ code: "ENOENT" });
});
