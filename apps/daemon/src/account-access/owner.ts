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
 *
 * The owner may instead be an organization (ADR 0206 §2.1): `{kind: "org", org}`. Its members'
 * grants carry their standing then, no person's grant does, and only a release (an owner of the
 * organization's, or a local reset) hands the machine on.
 */

const PersonOwner = z.object({ account: z.string().min(1).max(256) });
/** An organization's host (ADR 0206 §2.1): its members' grants carry standing, nobody's person's. */
const OrgOwner = z.object({
  kind: z.literal("org"),
  org: z.string().regex(/^org_[A-Za-z0-9]{1,64}$/),
});
type Owner = { kind: "person"; account: string } | { kind: "org"; org: string };
const file = (dataDir: string) => join(dataDir, "ace-owner.json");
const parseOwner = (raw: unknown): Owner => {
  const org = OrgOwner.safeParse(raw);
  if (org.success) return { kind: "org", org: org.data.org };
  return { kind: "person", account: PersonOwner.parse(raw).account };
};

export function machineOwner(dataDir: string) {
  let owner: Owner | undefined;
  let generation = 0;
  let changing = false;
  let turn: Promise<unknown> = Promise.resolve();
  /** Runs `change` after every earlier claim or release has finished. */
  const exclusive = <T>(change: () => Promise<T>): Promise<T> => {
    const run = turn.then(change);
    turn = run.catch(() => {});
    return run;
  };
  const write = async (next: Owner) => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file(dataDir)}.${randomUUID()}`;
    const body = next.kind === "org" ? { kind: "org", org: next.org } : { account: next.account };
    await writeFile(temporary, JSON.stringify(body), { mode: 0o600 });
    await rename(temporary, file(dataDir));
  };
  /**
   * A change of owner: every standing proven so far ends as it starts, `drop` runs before
   * anything can be proven again, then `apply` writes what comes next.
   */
  const change = async (drop: () => void, apply: () => Promise<void>) => {
    changing = true;
    generation++;
    try {
      drop();
      await apply();
    } finally {
      generation++;
      changing = false;
    }
  };
  return {
    async load(): Promise<void> {
      try {
        owner = parseOwner(JSON.parse(await readFile(file(dataDir), "utf8")));
      } catch {
        owner = undefined;
      }
    },
    /**
     * The owner's account id: undefined before any person's proof was taken, and on an
     * organization's host, where no person owns the machine (`org`).
     */
    current: (): string | undefined => (owner?.kind === "person" ? owner.account : undefined),
    /** The organization whose host this is (ADR 0206 §2.1), or undefined. */
    org: (): string | undefined => (owner?.kind === "org" ? owner.org : undefined),
    /** The generation a proof starting now is checked against (`holds`, `claim`). */
    generation: (): number => generation,
    /** Whether standing proven under `seen` still counts: no change since, and none under way. */
    holds: (seen: number): boolean => !changing && seen === generation,
    /**
     * `account`'s proof, begun under `seen`, stands: it is the owner's, or there is no owner yet
     * and it becomes one. False when another account or an organization owns the machine, or the
     * owner changed or is changing since the proof began.
     */
    claim(account: string, seen: number): Promise<boolean> {
      return exclusive(async () => {
        if (changing || seen !== generation) return false;
        if (owner !== undefined) return owner.kind === "person" && owner.account === account;
        // Nothing was proven without an owner, so no standing needs to end here.
        const next: Owner = { kind: "person", account };
        await write(next);
        owner = next;
        return true;
      });
    },
    /**
     * The person `account`, proven under `seen`, gives the machine to `org` (ADR 0206 §2.1):
     * false unless they still own it and nothing changed since. Every standing ends as it starts,
     * and `drop` ends what is kept beyond a socket, as a release does.
     */
    enroll(account: string, org: string, seen: number, drop: () => void): Promise<boolean> {
      return exclusive(async () => {
        if (changing || seen !== generation) return false;
        if (owner?.kind !== "person" || owner.account !== account) return false;
        const next: Owner = { kind: "org", org };
        await change(drop, async () => {
          await write(next);
          owner = next;
        });
        return true;
      });
    },
    /**
     * No owner: the next person's proof sets one. Every standing proven so far ends as this
     * starts; `drop` runs then, before anything can be proven again, to end what is kept beyond
     * a socket (paired devices' standing, person's links).
     */
    release(drop: () => void): Promise<void> {
      return exclusive(() =>
        change(drop, async () => {
          await rm(file(dataDir), { force: true });
          owner = undefined;
        }),
      );
    },
  };
}
export type MachineOwner = ReturnType<typeof machineOwner>;
