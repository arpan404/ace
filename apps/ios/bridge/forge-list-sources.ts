import { ClientError } from "@ace/client";
import type { ForgeRepository } from "@ace/protocol";
import { forgeErrorText, repositoryLabel, reviewRepositories, type RowGroup } from "@ace/ui-core";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * Which repositories a project's Pull requests and Issues read (ADR 0116): every visible,
 * available one the daemon lists, each read on its own so one that fails leaves the others on
 * screen with a sentence saying which one couldn't be read. Groups from every repository merge
 * into one list in the same groups, each group ordered by the list's own rule.
 */

export interface ListSource {
  /** Named in every read; undefined reads the project's own (a daemon before ADR 0116). */
  repository: ForgeRepository | undefined;
  /** "GitLab · acme/ace", only when the project lists more than one repository. */
  label: string | null;
}

/** The repositories a list reads. A daemon that can't list them reads the project's own. */
export async function listSources(reads: ForgeReads, project: string): Promise<ListSource[]> {
  const listed = await reads
    .repositories(project)
    .then(reviewRepositories)
    .catch((): ForgeRepository[] => []);
  if (listed.length === 0) return [{ repository: undefined, label: null }];
  const several = listed.length > 1;
  return listed.map((repository) => ({
    repository,
    label: several ? repositoryLabel(repository) : null,
  }));
}

export interface Answered<T> {
  source: ListSource;
  value: T;
}

const codeOf = (error: unknown) =>
  error instanceof ForgeRefusal || error instanceof ClientError ? error.code : undefined;

/**
 * Each source's answer, read together. A source that fails becomes a sentence naming it; when
 * every source fails the first failure is the list's, as it was with one repository.
 */
export async function readEach<T>(
  sources: readonly ListSource[],
  read: (source: ListSource) => Promise<T>,
): Promise<{ answers: Answered<T>[]; failed: string[] }> {
  const settled = await Promise.allSettled(sources.map(read));
  const answers: Answered<T>[] = [];
  const failed: string[] = [];
  let first: unknown;
  settled.forEach((result, index) => {
    const source = sources[index];
    if (!source) return;
    if (result.status === "fulfilled") answers.push({ source, value: result.value });
    else {
      first ??= result.reason;
      const words = forgeErrorText(codeOf(result.reason), source.repository?.forge);
      failed.push(source.label ? `${source.label}: ${words}` : words);
    }
  });
  if (answers.length === 0) throw first;
  return { answers, failed };
}

/**
 * Groups from several repositories as one list: groups in the order they first appear, each
 * holding every repository's rows once, in `order`. A group's total is known only when every repository
 * showing it gave one.
 */
export function mergeGroups<T>(
  lists: readonly { groups: readonly RowGroup<T>[]; totals: Record<string, number> | undefined }[],
  key: (row: T) => string,
  order: (rows: readonly T[]) => T[],
): { group: RowGroup<T>; total: number | null }[] {
  const merged = new Map<string, { group: RowGroup<T>; total: number | null }>();
  // A row two repositories both answered with shows once, where it first came.
  const seen = new Set<string>();
  const fresh = (rows: readonly T[]) =>
    rows.filter((row) => !seen.has(key(row)) && Boolean(seen.add(key(row))));
  for (const list of lists)
    for (const group of list.groups) {
      const total = list.totals?.[group.id];
      const kept = merged.get(group.id);
      if (!kept) {
        merged.set(group.id, {
          group: { id: group.id, label: group.label, rows: fresh(group.rows) },
          total: total ?? null,
        });
        continue;
      }
      kept.group.rows.push(...fresh(group.rows));
      kept.total = kept.total === null || total === undefined ? null : kept.total + total;
    }
  if (lists.length > 1)
    for (const entry of merged.values()) entry.group.rows = order(entry.group.rows);
  return [...merged.values()];
}
