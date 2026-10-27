import type { ReadPage } from "./changes-files.ts";
import { cutIn, type Reads } from "./changes-scope.ts";

/*
 * The versions of files cut from the checkout's patch. Such a file's version is the daemon's
 * validator for its whole patch, known once its first page is read: an open file reads it as it
 * loads, and a file the person marked viewed has it read here after each checkout read, so its
 * mark holds only while its content does. One file at a time, and only marked ones.
 */

export interface CutVersionsInput {
  reads: Reads;
  /** Still the session's current read: a later one starts its own round. */
  current: () => boolean;
  /** Paths whose version is wanted (marked viewed and not open). */
  paths: readonly string[];
  readPage: ReadPage;
  learned: () => void;
}

/** Learn the versions of `paths` that are cut from `reads` and not known yet. */
export async function learnCutVersions(input: CutVersionsInput): Promise<void> {
  const { reads } = input;
  for (const path of input.paths) {
    if (!input.current()) return;
    const file = reads.byPath.get(path);
    if (!file || file.binary || !cutIn(reads, path) || reads.validators.has(path)) continue;
    const page = await input.readPage(path, file.from ?? null, 0, undefined).catch(() => undefined);
    if (!input.current() || !page || page === "changed" || page.validator === undefined) continue;
    reads.validators.set(path, page.validator);
    input.learned();
  }
}
