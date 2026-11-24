import { Agent, BackgroundTask, Interaction, type ThreadStatus } from "@ace/protocol";
import type { ThreadWork } from "@ace/ui-core";
import { z } from "zod";

/*
 * What the Summary keeps of each delegated thread, per parent thread, so reopening it paints
 * the tree at once instead of reading every child again. A child is kept only once it settled
 * (done or failed) and its facts were confirmed; its entry is trusted again only while the
 * thread list still shows it settled and unchanged since (same `updatedAt`). Anything else
 * (working, waiting, touched since, or missing from the list) is read live as before, so a
 * kept entry never stands for a status that has moved on. Pure, but for the keep it is given.
 */

/** Where the entries are kept: the SDK's read snapshots, scoped to this machine and device. */
export interface TreeKeep {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One settled delegate's own facts and the `updatedAt` of its thread they were read at. */
export interface KeptChild {
  updatedAt: number;
  work: ThreadWork;
}

const Kept = z.object({
  v: z.literal(1),
  children: z.record(
    z.string(),
    z.object({
      updatedAt: z.number(),
      agents: z.array(Agent),
      tasks: z.array(BackgroundTask),
      interactions: z.array(Interaction),
      status: z.unknown().optional(),
    }),
  ),
});

const keyOf = (threadId: string) => `summary-tree:v1:${threadId}`;

/** Done and failed hold still until the thread is touched again, which moves `updatedAt`. */
export const settledStatus = (status: ThreadStatus | undefined): boolean =>
  status?.state === "done" || status?.state === "failed";

/** The kept entries of `threadId`'s tree; none when nothing is kept or it can't be read. */
export async function loadTree(keep: TreeKeep, threadId: string): Promise<Map<string, KeptChild>> {
  const out = new Map<string, KeptChild>();
  try {
    const parsed = Kept.safeParse(await keep.get(keyOf(threadId)));
    if (!parsed.success) return out;
    for (const [id, child] of Object.entries(parsed.data.children))
      out.set(id, {
        updatedAt: child.updatedAt,
        work: {
          agents: child.agents,
          tasks: child.tasks,
          interactions: child.interactions,
          ...(child.status === undefined ? {} : { status: child.status as ThreadStatus }),
          facts: "live",
        },
      });
  } catch {
    // A miss: the tree is read live.
  }
  return out;
}

export async function saveTree(
  keep: TreeKeep,
  threadId: string,
  children: ReadonlyMap<string, KeptChild>,
): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const [id, { updatedAt, work }] of children)
    out[id] = {
      updatedAt,
      agents: work.agents,
      tasks: work.tasks,
      interactions: work.interactions,
      ...(work.status === undefined ? {} : { status: work.status }),
    };
  try {
    await keep.set(keyOf(threadId), { v: 1, children: out });
  } catch {
    // Not kept this time; the next settle writes again.
  }
}

/** Drop a thread's kept tree (it was deleted). */
export async function forgetTree(keep: TreeKeep, threadId: string): Promise<void> {
  try {
    await keep.delete(keyOf(threadId));
  } catch {
    // Left to the store's own expiry.
  }
}

/** The thread list's word on one delegate: absent, or its status and last change. */
export interface Listed {
  status: ThreadStatus;
  updatedAt: number;
}

/**
 * How far a kept entry may stand for its thread now: `live` when the confirmed list shows the
 * thread settled and untouched since; `syncing` while the list itself is still unconfirmed (the
 * rows say they are being confirmed); undefined when it must be read.
 */
export function keptStanding(
  kept: KeptChild | undefined,
  listed: Listed | undefined,
  confirmed: boolean,
): "live" | "syncing" | undefined {
  if (!kept) return undefined;
  if (listed && (!settledStatus(listed.status) || listed.updatedAt !== kept.updatedAt))
    return undefined;
  if (confirmed) return listed ? "live" : undefined;
  return "syncing";
}
