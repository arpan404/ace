import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * Where New thread copied a project to (ADR 0102): the next move or send to the same machine
 * reuses that copy instead of making another. A Git checkout with an origin is found again by
 * its origin anyway; a plain folder or a repository without one has only this to go by.
 */

const storageKey = "ace.home.copiedProjects";
const Copy = z.object({
  /** The machine the project is on, and its id there. */
  from: z.string().min(1),
  project: z.string().min(1),
  /** The machine it was copied to, by host id, and its id there. */
  to: z.string().min(1),
  landed: z.string().min(1),
});
type Copy = z.infer<typeof Copy>;
const Copies = z.array(Copy).catch([]);
/** The most copies kept; the oldest go first. */
const kept = 100;

const same = (a: Omit<Copy, "landed">, b: Omit<Copy, "landed">) =>
  a.from === b.from && a.project === b.project && a.to === b.to;

export function rememberCopy(storage: KeyValueStorage | undefined, copy: Copy): void {
  const others = readJson(storage, storageKey, Copies, []).filter((each) => !same(each, copy));
  writeJson(storage, storageKey, [...others, copy].slice(-kept));
}

/**
 * The id the project from `from` has on machine `to`, when New thread copied it there, either
 * way round: a copy taken back to the machine it came from is the original there.
 */
export function copiedTo(
  storage: KeyValueStorage | undefined,
  from: string,
  project: string,
  to: string,
): string | undefined {
  const copies = readJson(storage, storageKey, Copies, []);
  return (
    copies.find((each) => same(each, { from, project, to }))?.landed ??
    copies.find((each) => each.to === from && each.landed === project && each.from === to)?.project
  );
}
