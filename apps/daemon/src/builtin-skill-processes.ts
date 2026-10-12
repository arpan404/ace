import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ProcessIdentity,
  processIdentity,
  processGroupIsGone,
} from "@ace/provider-kit/process-identity";
import type { ProcessLease } from "@ace/provider-kit/process";

const filename = "skill-processes.json";
const LeaseRecord = z.strictObject({
  version: z.literal(1),
  owner: ProcessIdentity,
  processes: z.array(ProcessIdentity).max(64),
  launching: z.boolean(),
  closed: z.boolean(),
});
type LeaseRecord = z.infer<typeof LeaseRecord>;
export interface SkillProcessRuntime {
  ownerPid: number;
  /** undefined means confirmed absent; unavailable inspection must throw. */
  identity(pid: number): ProcessIdentity | undefined;
  groupGone(group: number): boolean;
}
export const skillProcessRuntime: SkillProcessRuntime = {
  ownerPid: process.pid,
  identity: processIdentity,
  groupGone: processGroupIsGone,
};

/** All inputs are validated before they can authorize deletion. Never follow a metadata symlink. */
function readLease(root: string): LeaseRecord {
  const file = openSync(join(root, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 32768) throw new Error("Invalid skill process lease");
    return LeaseRecord.parse(JSON.parse(readFileSync(file, "utf8")));
  } finally {
    closeSync(file);
  }
}
/** Synchronous and atomic: a spawn cannot overtake its durable pending marker. */
function writeLease(root: string, record: LeaseRecord): void {
  const temporary = join(root, `${filename}.next`);
  const file = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(file, JSON.stringify(LeaseRecord.parse(record)));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, join(root, filename));
}
function sameProcess(saved: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  // A live process can change uid or group. Its unchanged kernel start still retains the lease.
  return current !== undefined && saved.pid === current.pid && saved.start === current.start;
}

/** Liveness uncertainty, a pending spawn, or a surviving group always retains the projection. */
export function builtinSkillRootUnused(
  root: string,
  runtime: SkillProcessRuntime = skillProcessRuntime,
): boolean {
  const record = readLease(root);
  if (record.launching) return false;
  if (!record.closed && sameProcess(record.owner, runtime.identity(record.owner.pid))) return false;
  for (const saved of record.processes) {
    if (saved.uid !== record.owner.uid || saved.group !== saved.pid)
      throw new Error("Invalid provider process ownership");
    if (sameProcess(saved, runtime.identity(saved.pid)) || !runtime.groupGone(saved.group))
      return false;
  }
  return true;
}

export interface BuiltinSkillProcessLease extends ProcessLease {
  close(): void;
}
/** Created after plugin materialization, before any provider receives the projection. */
export function builtinSkillProcessLease(
  root: string,
  runtime: SkillProcessRuntime = skillProcessRuntime,
): BuiltinSkillProcessLease {
  const owner = runtime.identity(runtime.ownerPid);
  if (!owner || owner.pid !== runtime.ownerPid)
    throw new Error("Cannot identify skill projection owner");
  let record: LeaseRecord = { version: 1, owner, processes: [], launching: false, closed: false };
  writeLease(root, record);
  return {
    preparing() {
      if (record.closed || record.launching || record.processes.length >= 64)
        throw new Error("Skill process lease is closed, unresolved or full");
      record = { ...record, launching: true };
      writeLease(root, record);
    },
    spawned(pid) {
      if (record.closed || !record.launching) throw new Error("No pending skill process launch");
      const identity = runtime.identity(pid);
      if (!identity || identity.pid !== pid || identity.uid !== owner.uid || identity.group !== pid)
        throw new Error("Cannot identify owned provider process");
      record = { ...record, processes: [...record.processes, identity], launching: false };
      writeLease(root, record);
    },
    close() {
      record = { ...record, closed: true };
      writeLease(root, record);
    },
  };
}
