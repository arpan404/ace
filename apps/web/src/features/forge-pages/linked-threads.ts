import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import type { ForgeRepository } from "@ace/protocol";

/** A thread working on a pull request or issue, as the thread list knows it. */
export interface LinkedThread {
  id: string;
  title: string;
}
export type LinkedThreads = ReadonlyMap<string, LinkedThread>;

/** One key per PR or issue: repository and number, case-insensitive like GitHub's names. */
export function workKey(repository: Pick<ForgeRepository, "owner" | "name">, number: number) {
  return `${repository.owner}/${repository.name}#${number}`.toLowerCase();
}

/**
 * Which PRs and issues the loaded threads are linked to, newest thread first: the thread list
 * already carries every link, so a row can name its thread without asking the daemon.
 */
function readLinks(reader: SidebarReader): { pulls: LinkedThreads; issues: LinkedThreads } {
  const pulls = new Map<string, LinkedThread>();
  const issues = new Map<string, LinkedThread>();
  for (const id of reader.ids) {
    const thread = reader.thread(id);
    if (!thread || thread.archivedAt !== undefined) continue;
    const linked = { id: thread.id, title: thread.title };
    for (const pr of thread.details?.linkedPrs ?? []) {
      const key = workKey(pr.repo, pr.number);
      if (!pulls.has(key)) pulls.set(key, linked);
    }
    for (const issue of thread.details?.linkedIssues ?? []) {
      const key = workKey(issue.repository, issue.number);
      if (!issues.has(key)) issues.set(key, linked);
    }
  }
  return { pulls, issues };
}

const same = (x: LinkedThreads, y: LinkedThreads) =>
  x.size === y.size &&
  [...x].every(([key, thread]) => {
    const other = y.get(key);
    return other?.id === thread.id && other.title === thread.title;
  });
const sameLinks = (a: ReturnType<typeof readLinks>, b: ReturnType<typeof readLinks>): boolean =>
  same(a.pulls, b.pulls) && same(a.issues, b.issues);

const none = { pulls: new Map(), issues: new Map() } as const;

export function useLinkedThreads(): { pulls: LinkedThreads; issues: LinkedThreads } {
  return useSidebarAll(readLinks, sameLinks) ?? none;
}
