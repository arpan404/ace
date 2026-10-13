import { z } from "zod";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

const objectId = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const branchRef = z
  .string()
  .max(1024)
  .regex(/^refs\/heads\/[^\s:~^?*[\\]+$/)
  .refine((ref) => !ref.includes("..") && !ref.endsWith("/") && !ref.endsWith(".lock"));

export type LeasedRefUpdate = { ref: string; lease: string; target: string };
export type LeasedPushOptions = {
  worktree: string;
  remote: string;
  updates: readonly LeasedRefUpdate[];
  signal?: AbortSignal;
  /** Runs immediately before Git is spawned, after every local precondition passed. */
  beforeDispatch?: () => void;
};
export type LeasedPushRef = {
  ref: string;
  status: "updated" | "up_to_date" | "rejected";
  reason: string | null;
};
/** Git's own per-ref report. An empty `refs` list means Git never reported a decision. */
export type LeasedPushResult = { exitCode: number; refs: LeasedPushRef[] };

const flags: Record<string, LeasedPushRef["status"]> = {
  " ": "updated",
  "+": "updated",
  "*": "updated",
  "=": "up_to_date",
  "!": "rejected",
};

/** Parse `git push --porcelain` stdout: `<flag>\t<from>:<to>\t<summary>` per ref. */
export function parsePushPorcelain(stdout: string): LeasedPushRef[] {
  const refs: LeasedPushRef[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(.)\t[^\t]*:([^\t]+)\t(.*)$/.exec(line);
    const status = match?.[1] === undefined ? undefined : flags[match[1]];
    if (!match?.[2] || !status) continue;
    const reason = /\(([^)]*)\)\s*$/.exec(match[3] ?? "")?.[1] ?? null;
    refs.push({ ref: match[2], status, reason });
  }
  return refs;
}

/**
 * Atomically move several branches, each only if the remote still holds its leased revision.
 * The leases are caller-supplied revisions, never freshly fetched remote-tracking values,
 * so a collaborator's commit pushed after review makes the whole push fail.
 */
export async function pushLeasedRefs(
  repository: Repository,
  options: LeasedPushOptions,
): Promise<LeasedPushResult> {
  const remote = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w./-]+$/)
    .refine((value) => !value.startsWith("-"))
    .parse(options.remote);
  const updates = z
    .array(z.object({ ref: branchRef, lease: objectId, target: objectId }))
    .min(1)
    .max(100)
    .refine((list) => new Set(list.map((update) => update.ref)).size === list.length)
    .parse(options.updates);
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    const info = await repository.info(root);
    if (!info.remotes.some((entry) => entry.name === remote))
      throw new GitError("invalid_argument", "Select an existing remote");
    for (const update of updates) {
      const exists = await repository.cli.call(
        root,
        ["cat-file", "-e", `${update.target}^{commit}`],
        { allowFailure: true, ...(options.signal ? { signal: options.signal } : {}) },
      );
      if (exists.exitCode !== 0)
        throw new GitError("invalid_ref", "A published revision is not in this checkout");
    }
    const output = await repository.cli.push(
      root,
      [
        "push",
        "--atomic",
        "--porcelain",
        ...updates.map((update) => `--force-with-lease=${update.ref}:${update.lease}`),
        "--",
        remote,
        ...updates.map((update) => `${update.target}:${update.ref}`),
      ],
      {
        write: true,
        allowFailure: true,
        timeoutMs: 600_000,
        captureBytes: 262_144,
        beforeSpawn: () => options.beforeDispatch?.(),
        ...(options.signal ? { signal: options.signal } : {}),
        env: { GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
      },
    );
    const planned = new Set(updates.map((update) => update.ref));
    return {
      exitCode: output.exitCode,
      refs: parsePushPorcelain(output.stdout.toString("utf8")).filter((ref) =>
        planned.has(ref.ref),
      ),
    };
  });
}
