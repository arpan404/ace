import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/*
 * The person this machine answers to (ADR 0190): the ace account whose person's grants carry the
 * person's standing here. Kept apart from the account the machine is signed in to, which the host
 * token can change (`PUT /v1/ace-account`): switching that to an account a reader of ACE_HOME
 * controls gives that account nothing. The first person's proof the machine takes sets it; only a
 * socket proven as the owner, or an explicit local reset that drops every person standing, clears
 * it. Each change moves `generation`, so standing proven under another owner ends at once.
 */

const Owner = z.object({ account: z.string().min(1).max(256) });
const file = (dataDir: string) => join(dataDir, "ace-owner.json");

export function machineOwner(dataDir: string) {
  let owner: string | undefined;
  let generation = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const save = (next: string | undefined) => {
    const run = writes.then(async () => {
      if (next === undefined) {
        await rm(file(dataDir), { force: true });
        return;
      }
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${file(dataDir)}.${randomUUID()}`;
      await writeFile(temporary, JSON.stringify({ account: next }), { mode: 0o600 });
      await rename(temporary, file(dataDir));
    });
    writes = run.catch(() => {});
    return run;
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
    /** Moves on every change of owner: standing proven before it no longer counts. */
    generation: (): number => generation,
    /** The first proof's account becomes the owner; false when another already is. */
    async claim(account: string): Promise<boolean> {
      if (owner !== undefined) return owner === account;
      owner = account;
      generation++;
      await save(account);
      return true;
    },
    /** No owner: the next person's proof sets one. Every standing proven so far ends. */
    async release(): Promise<void> {
      owner = undefined;
      generation++;
      await save(undefined);
    },
  };
}
export type MachineOwner = ReturnType<typeof machineOwner>;
