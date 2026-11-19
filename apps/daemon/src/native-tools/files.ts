import { readFile, stat } from "node:fs/promises";

/*
 * The files native tool rules read (a Codex `config.toml`, `~/.claude.json`), read on every
 * launch and status check: capped in size and kept while their size and change time hold.
 */

export interface NativeToolFiles {
  /** Rejects with an `ENOENT` code when the file is absent, `EFBIG` when it's over the cap. */
  readFile(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
}

export interface FileFacts {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  stat(path: string): Promise<FileFacts>;
  readFile(path: string): Promise<string>;
}

export const nodeFileSystem: FileSystem = {
  stat: (path) => stat(path),
  readFile: (path) => readFile(path, "utf8"),
};

/** Larger than any config ace reads here; a file past it is reported, never read. */
export const maxToolFileBytes = 1024 * 1024;
const maxCached = 16;

export function cachedToolFiles(fs: FileSystem, maxBytes = maxToolFileBytes): NativeToolFiles {
  const cache = new Map<string, { size: number; mtimeMs: number; text: string }>();
  return {
    async readFile(path) {
      const facts = await fs.stat(path);
      if (facts.size > maxBytes)
        throw Object.assign(new Error("Config file too large"), { code: "EFBIG" });
      const kept = cache.get(path);
      if (kept && kept.size === facts.size && kept.mtimeMs === facts.mtimeMs) return kept.text;
      const text = await fs.readFile(path);
      // A file that grew between the check and the read is held to the same cap.
      if (Buffer.byteLength(text) > maxBytes)
        throw Object.assign(new Error("Config file too large"), { code: "EFBIG" });
      cache.delete(path);
      if (cache.size >= maxCached) cache.delete(cache.keys().next().value ?? "");
      cache.set(path, { size: facts.size, mtimeMs: facts.mtimeMs, text });
      return text;
    },
    isDirectory: async (path) => (await fs.stat(path)).isDirectory(),
    isFile: async (path) => (await fs.stat(path)).isFile(),
  };
}
