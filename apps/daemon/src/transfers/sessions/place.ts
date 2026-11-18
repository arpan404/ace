import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishFile, rollback } from "@ace/accounts/session-files";
import { SessionNotCarried, assertSessionFile } from "./carrier.ts";

/**
 * Writes rewritten copies of staged session files into `home` (ADR 0190): each file is written
 * to a private stage inside the home first, then linked into place, which never replaces a file
 * that is there. Any failure removes every file this call placed.
 */
export async function placeFiles(input: {
  home: string;
  staged: string;
  files: { from: string; to: string }[];
  rewrite(text: string): string;
}): Promise<void> {
  // The home as the filesystem names it, so a link above it (macOS /var) isn't read as an escape.
  const home = await realpath(input.home);
  const stage = await mkdtemp(join(home, ".ace-move-"));
  const placed: string[] = [];
  try {
    for (const file of input.files) {
      assertSessionFile(file.from);
      assertSessionFile(file.to);
      const text = await readFile(join(input.staged, file.from), "utf8");
      const written = join(stage, file.to);
      // The stage is this call's own fresh folder, so its subfolders are made plainly.
      await mkdir(dirname(written), { recursive: true, mode: 0o700 });
      await writeFile(written, input.rewrite(text), { flag: "wx", mode: 0o600 });
      try {
        placed.push(await publishFile(stage, home, { source: written, relative: file.to }));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        // The same copy placed before a restart is this one; anything else is someone's own.
        const there = await readFile(join(home, file.to), "utf8").catch(() => undefined);
        if (there !== input.rewrite(text))
          throw new SessionNotCarried("This machine already has a session with that id");
        continue;
      }
    }
  } catch (error) {
    await rollback(placed).catch(() => undefined);
    throw error instanceof SessionNotCarried
      ? error
      : new SessionNotCarried("The session couldn't be written on this machine");
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
