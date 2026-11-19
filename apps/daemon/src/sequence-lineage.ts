import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

/*
 * The mark a daemon keeps beside its event database (ADR 0128): the database's name and the
 * highest sequence it reserved, written before any sequence in that range goes out. A database
 * found below its own mark was rolled back (a restored or copied `events.sqlite` under the same
 * host id) and will hand those sequences out again for other events, so it takes a new name and
 * every client reads it afresh. A mark that is missing or unreadable proves nothing.
 */

export interface LineageMark {
  token: string;
  reserved: number;
}
export interface LineageFile {
  read(): LineageMark | undefined;
  write(mark: LineageMark): void;
}

const Mark = z.object({
  token: z.string().min(1).max(128),
  reserved: z.number().int().nonnegative(),
});

/** Whether the database named `token`, reserved through `reserved`, is behind its own mark. */
export function rolledBack(
  mark: LineageMark | undefined,
  token: string,
  reserved: number,
): boolean {
  return mark !== undefined && mark.token === token && reserved < mark.reserved;
}

/** The mark at `path`, written whole or not at all. */
export function lineageFile(path: string): LineageFile {
  return {
    read() {
      try {
        const parsed = Mark.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    write(mark) {
      const next = `${path}.next`;
      writeFileSync(next, JSON.stringify(mark));
      renameSync(next, path);
    },
  };
}
