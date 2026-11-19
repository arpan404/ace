import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/*
 * The person this machine answers to (ADR 0190 §3a): the ace account whose person's grants carry
 * the person's standing here. Kept apart from the account the machine is signed in to, which the
 * host token can change (`PUT /v1/ace-account`): switching that to an account a reader of
 * ACE_HOME controls gives that account nothing. The first person's proof the machine takes sets
 * it, to the account that proof's own grant names; only the owner's own proof, or a local reset
 * that drops every person standing, clears it.
 *
 * Standing is stamped with the generation it was proven under and counts only while that is
 * current (`holds`). Claims and releases run one at a time; a release moves the generation as it
 * starts and again once it is done, and nothing is proven or claimed in between, so a proof that
 * began before a change never lands after it.
 */

const Owner = z.object({ account: z.string().min(1).max(256) });
const file = (dataDir: string) => join(dataDir, "ace-owner.json");

export function machineOwner(dataDir: string) {
  let owner: string | undefined;
  let generation = 0;
  let changing = false;
  let turn: Promise<unknown> = Promise.resolve();
  /** Runs `change` after every earlier claim or release has finished. */
  const exclusive = <T>(change: () => Promise<T>): Promise<T> => {
    const run = turn.then(change);
    turn = run.catch(() => {});
    return run;
  };
  const write = async (next: string) => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file(dataDir)}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ account: next }), { mode: 0o600 });
    await rename(temporary, file(dataDir));
  };
  return {
    async load(): Promise<void> {
      try {
        owner = Owner.parse(JSON.parse(await readFile(file(dataDir), "utf8"))).account;
      } catch {
        owner = undefined;
      }
    },
    /** The owner's account id, or undefined before any person's proof was taken. */
    current: (): string | undefined => owner,
    /** The generation a proof starting now is checked against (`holds`, `claim`). */
    generation: (): number => generation,
    /** Whether standing proven under `seen` still counts: no change since, and none under way. */
    holds: (seen: number): boolean => !changing && seen === generation,
    /**
     * `account`'s proof, begun under `seen`, stands: it is the owner's, or there is no owner yet
     * and it becomes one. False when another account owns the machine, or the owner changed or
     * is changing since the proof began.
     */
    claim(account: string, seen: number): Promise<boolean> {
      return exclusive(async () => {
        if (changing || seen !== generation) return false;
        if (owner !== undefined) return owner === account;
        // Nothing was proven without an owner, so no standing needs to end here.
        await write(account);
        owner = account;
        return true;
      });
    },
    /**
     * No owner: the next person's proof sets one. Every standing proven so far ends as this
     * starts; `drop` runs then, before anything can be proven again, to end what is kept beyond
     * a socket (paired devices' standing, person's links).
     */
    release(drop: () => void): Promise<void> {
      return exclusive(async () => {
        changing = true;
        generation++;
        try {
          drop();
          await rm(file(dataDir), { force: true });
          owner = undefined;
        } finally {
          generation++;
          changing = false;
        }
      });
    },
  };
}
export type MachineOwner = ReturnType<typeof machineOwner>;
