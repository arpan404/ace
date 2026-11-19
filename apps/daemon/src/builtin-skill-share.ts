import { rm } from "node:fs/promises";
import { prepareBuiltinSkills } from "@ace/plugins";
import { createBuiltinSkillRoot } from "./builtin-skill-roots.ts";
import {
  builtinSkillProcessLease,
  builtinSkillRootUnused,
  type BuiltinSkillProcessLease,
} from "./builtin-skill-processes.ts";
import type { ProcessLease } from "@ace/provider-kit/process";

type Holder = {
  root: string;
  skills: Awaited<ReturnType<typeof prepareBuiltinSkills>>;
  lease: BuiltinSkillProcessLease;
  users: number;
  /** Launches promised to users that have not started them yet. */
  reserved: number;
  retired: boolean;
  leaseClosed: boolean;
};
export type SharedBuiltinSkills = {
  args: string[];
  directories: string[];
  lease: ProcessLease;
  release(): Promise<void>;
};

/**
 * One projection of the shipped skill bundle for every session of a provider. Codex sessions
 * share an app-server, so identical spawn arguments let them run on one process; Claude sessions
 * each launch their own process from the same read-only copy, so each acquisition reserves its
 * launch up front. A root is replaced once its lease cannot promise another launch, and removed
 * when nothing uses it. A replaced root's lease stays open for users still holding it.
 */
export function sharedBuiltinSkills(provider: "claude" | "codex", dataDir: string) {
  const launchesPerUser = provider === "claude";
  let current: Promise<Holder> | undefined;
  async function create(): Promise<Holder> {
    const root = await createBuiltinSkillRoot(dataDir);
    try {
      const skills = await prepareBuiltinSkills(provider, root);
      return {
        root,
        skills,
        lease: builtinSkillProcessLease(root),
        users: 0,
        reserved: 0,
        retired: false,
        leaseClosed: false,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  async function cleanup(holder: Holder): Promise<void> {
    if (!holder.retired || holder.users) return;
    if (!holder.leaseClosed) {
      holder.leaseClosed = true;
      holder.lease.close();
    }
    // A process still running from this root keeps it; the next daemon start reclaims it.
    if (!builtinSkillRootUnused(holder.root)) return;
    await holder.skills.close();
    await rm(holder.root, { recursive: true, force: true });
  }
  function retire(holder: Holder): void {
    holder.retired = true;
  }
  async function usable(): Promise<Holder> {
    for (;;) {
      const pending = (current ??= create());
      let holder: Holder;
      try {
        holder = await pending;
      } catch (error) {
        if (current === pending) current = undefined;
        throw error;
      }
      const promised = launchesPerUser ? holder.reserved : 0;
      if (!holder.retired && holder.lease.spare() - promised > 0) {
        // Taken in the same step as the check, so concurrent acquisitions cannot overbook it.
        holder.users++;
        if (launchesPerUser) holder.reserved++;
        return holder;
      }
      if (current === pending) {
        current = undefined;
        retire(holder);
        void cleanup(holder).catch(() => {});
      }
    }
  }
  return {
    async acquire(): Promise<SharedBuiltinSkills> {
      const holder = await usable();
      let reservation = launchesPerUser;
      const spend = () => {
        if (!reservation) return;
        reservation = false;
        holder.reserved--;
      };
      let released = false;
      return {
        args: [...holder.skills.args],
        directories: [...holder.skills.directories],
        lease: {
          preparing() {
            spend();
            holder.lease.preparing();
          },
          spawned: (pid) => holder.lease.spawned(pid),
        },
        async release() {
          if (released) return;
          released = true;
          spend();
          holder.users--;
          await cleanup(holder);
        },
      };
    },
    async close(): Promise<void> {
      const pending = current;
      current = undefined;
      const holder = await pending?.catch(() => undefined);
      if (!holder) return;
      retire(holder);
      await cleanup(holder);
    },
  };
}
