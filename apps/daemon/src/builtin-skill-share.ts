import { rm } from "node:fs/promises";
import { prepareBuiltinSkills } from "@ace/plugins";
import { createBuiltinSkillRoot } from "./builtin-skill-roots.ts";
import {
  builtinSkillProcessLease,
  builtinSkillRootUnused,
  type BuiltinSkillProcessLease,
} from "./builtin-skill-processes.ts";

type Holder = {
  root: string;
  skills: Awaited<ReturnType<typeof prepareBuiltinSkills>>;
  lease: BuiltinSkillProcessLease;
  users: number;
  retired: boolean;
};
export type SharedBuiltinSkills = {
  args: string[];
  directories: string[];
  lease: BuiltinSkillProcessLease;
  release(): Promise<void>;
};

/**
 * One projection of the shipped skill bundle for every session of a provider whose process is
 * shared. Identical spawn arguments let those sessions run on one process. A root is replaced
 * once its lease cannot record another launch, and removed when nothing uses it.
 */
export function sharedBuiltinSkills(provider: "codex", dataDir: string) {
  let current: Promise<Holder> | undefined;
  async function create(): Promise<Holder> {
    const root = await createBuiltinSkillRoot(dataDir);
    try {
      const skills = await prepareBuiltinSkills(provider, root);
      return { root, skills, lease: builtinSkillProcessLease(root), users: 0, retired: false };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  async function cleanup(holder: Holder): Promise<void> {
    // A process still running from this root keeps it; the next daemon start reclaims it.
    if (!holder.retired || holder.users || !builtinSkillRootUnused(holder.root)) return;
    await holder.skills.close();
    await rm(holder.root, { recursive: true, force: true });
  }
  function retire(holder: Holder): void {
    if (holder.retired) return;
    holder.retired = true;
    holder.lease.close();
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
      if (!holder.retired && holder.lease.spare() > 0) return holder;
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
      holder.users++;
      let released = false;
      return {
        args: [...holder.skills.args],
        directories: [...holder.skills.directories],
        lease: holder.lease,
        async release() {
          if (released) return;
          released = true;
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
