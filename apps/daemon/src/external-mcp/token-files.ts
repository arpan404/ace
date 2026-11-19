import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureDataDir } from "../local-files.ts";

const grantId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/**
 * The private files `ace mcp enroll` writes each pasted token to (0600, in a 0700 directory), so
 * setup commands load it from a file instead of carrying it. A file goes when its grant ends.
 */
export function tokenFiles(dataDir: string) {
  const directory = join(dataDir, "mcp-enrollments");
  secureDataDir(directory);
  const path = (id: string) => join(directory, `${grantId.parse(id)}.token`);
  return {
    write(id: string, token: string): string {
      const file = path(id);
      writeFileSync(file, token, { mode: 0o600, flag: "wx" });
      return file;
    },
    remove(id: string): void {
      removeQuietly(path(id));
    },
    /** Removes the files of grants that ended while the daemon was stopped. */
    sweep(live: (id: string) => boolean): void {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".token")) continue;
        const id = grantId.safeParse(name.slice(0, -".token".length));
        if (!id.success || !live(id.data)) removeQuietly(join(directory, name));
      }
    },
  };
}
