import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stage, type PersonFile } from "./person-requests.ts";

/** The most one drop may write, all its files together. */
export const dropBytesMax = 64 * 1024 * 1024;
/** Drops kept for pages that read their files late (on submit); older ones are removed. */
const kept = 4;

/**
 * Files the person dropped on a thread's pages, written under the session's own folder so the
 * page can read them. Only the last few drops are kept, and closing the session removes them all.
 */
export class DroppedFiles {
  #root: string;
  #id: () => string;
  #drops: string[] = [];
  constructor(sessionDir: string, id: () => string) {
    this.#root = join(sessionDir, "dropped-files");
    this.#id = id;
  }
  /** Writes one drop's files; their paths, in order. Over `dropBytesMax` it writes none. */
  async stage(files: readonly PersonFile[]): Promise<string[]> {
    const folder = join(this.#root, this.#id());
    this.#drops.push(folder);
    let total = 0;
    const counted = files.map((file) => ({
      name: file.name,
      open: async () => {
        const source = await file.open();
        return {
          close: source.close,
          chunks: (async function* () {
            for await (const chunk of source.chunks) {
              total += chunk.byteLength;
              if (total > dropBytesMax) throw new Error("Dropped files are too large");
              yield chunk;
            }
          })(),
        };
      },
    }));
    try {
      return await stage(counted, folder);
    } catch (error) {
      await this.#remove(folder);
      throw error;
    } finally {
      while (this.#drops.length > kept) await this.#remove(this.#drops[0] ?? "");
    }
  }
  async close(): Promise<void> {
    this.#drops = [];
    await rm(this.#root, { recursive: true, force: true });
  }
  async #remove(folder: string): Promise<void> {
    this.#drops = this.#drops.filter((drop) => drop !== folder);
    await rm(folder, { recursive: true, force: true });
  }
}
