import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Identity = z.object({ dev: z.number(), ino: z.number() });
const entryName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes("/") && !name.includes("\0") && name !== "." && name !== "..");
/**
 * One update apply in flight: where it happens and which directories are whose. Written to ace's
 * own data directory before the first rename and removed once the swap is settled.
 */
export const SwapJournal = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  /** Resolved skill root, opened from `/` without following links. */
  rootReal: z.string().min(1).max(4096),
  /** The skill folder, its staged replacement and the backup of the original, in `rootReal`. */
  name: entryName,
  next: entryName,
  old: entryName,
  folderHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  /** The folder that was installed when the apply began. */
  original: Identity,
  /** The staged replacement. */
  installed: Identity,
  /** The lock file's temporary sibling, if a write may have left one. */
  lockTemporary: z.string().min(1).max(4096),
});
export type SwapJournal = z.infer<typeof SwapJournal>;

/** Swap journals in one private directory: one file per apply, replaced atomically. */
export class SwapJournals {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async write(journal: SwapJournal): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, `${journal.id}.json`);
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }
  async remove(id: string): Promise<void> {
    await rm(join(this.root, `${id}.json`), { force: true });
  }
  /** Every readable journal; anything malformed is reported by name and left alone. */
  async list(): Promise<{ journals: SwapJournal[]; unreadable: string[] }> {
    const journals: SwapJournal[] = [];
    const unreadable: string[] = [];
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.root, name);
      try {
        journals.push(SwapJournal.parse(JSON.parse(await readFile(path, "utf8"))));
      } catch {
        unreadable.push(path);
      }
    }
    return { journals, unreadable };
  }
}
