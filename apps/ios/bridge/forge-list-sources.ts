import { ClientError } from "@ace/client";
import type { ForgeRepository, ProjectRepository } from "@ace/protocol";
import {
  forgeErrorText,
  issueSources,
  repositoryLabel,
  repositoryCapabilities,
  type ForgeCapabilitySource,
  reviewSources,
  type RowGroup,
} from "@ace/ui-core";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * Which repositories a project's Pull requests and Issues read (ADR 0120), by the web's own rule
 * (`reviewSources`, `issueSources`): every visible, available repository the daemon lists (for
 * issues, those ace reads issues from), each read on its own so one that fails leaves the others
 * on screen with a sentence saying which one couldn't be read. Groups from every repository merge
 * into one list in the same groups, each group ordered by the list's own rule.
 */

export interface ListSource {
  /** Named in every read; undefined reads the project's primary, as before ADR 0120. */
  repository: ForgeRepository | undefined;
  capabilitySource?: ForgeCapabilitySource | undefined;
  /** "GitLab · acme/ace", only when the project lists more than one repository. */
  label: string | null;
}

/** What a list reads, and the sentence saying the project's repositories couldn't be read. */
export interface ListPlan {
  sources: ListSource[];
  entries: ProjectRepository[];
  /** Set when the repositories couldn't be read: the primary alone is read, and totals are unknown. */
  unlisted: string | null;
}

const unlistedText = "Couldn't read this project's repositories, so only its primary is listed.";

async function plan(
  reads: ForgeReads,
  project: string,
  rule: typeof reviewSources,
): Promise<ListPlan> {
  const value = await reads.repositories(project).catch(() => undefined);
  if (!value)
    return {
      sources: [{ repository: undefined, label: null }],
      entries: [],
      unlisted: unlistedText,
    };
  const sources = rule([project], new Map([[project, value]]));
  return {
    entries: value.repositories,
    sources: sources.map((source) => ({
      repository: source.repository,
      capabilitySource: source.repository
        ? repositoryCapabilities(source.repository, value.repositories)
        : value.primary
          ? repositoryCapabilities(value.primary, value.repositories)
          : undefined,
      label: source.shown ? repositoryLabel(source.shown) : null,
    })),
    unlisted: null,
  };
}

/** The repositories a project's Pull requests read. */
export const pullSources = (reads: ForgeReads, project: string) =>
  plan(reads, project, reviewSources);
/** The repositories a project's Issues read: those whose host ace reads issues from. */
export const issueListSources = (reads: ForgeReads, project: string) =>
  plan(reads, project, issueSources);

export interface Answered<T> {
  source: ListSource;
  value: T;
}

const codeOf = (error: unknown) =>
  error instanceof ForgeRefusal || error instanceof ClientError ? error.code : undefined;

/**
 * Each source's answer, read together. A source that fails becomes a sentence naming it; when
 * every source fails the first failure is the list's, as it was with one repository. No sources
 * (every repository hidden) is an empty answer.
 */
export async function readEach<T>(
  sources: readonly ListSource[],
  read: (source: ListSource) => Promise<T>,
): Promise<{ answers: Answered<T>[]; failed: string[] }> {
  if (!sources.length) return { answers: [], failed: [] };
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
 * holding every repository's rows once, in `order`. A group's total is known only when the list
 * is `complete` (every repository answered) and every repository counted it; it is then the sum
 * of every repository's total for it, whether or not that repository's rows so far show it.
 */
export function mergeGroups<T>(
  lists: readonly { groups: readonly RowGroup<T>[]; totals: Record<string, number> | undefined }[],
  key: (row: T) => string,
  order: (rows: readonly T[]) => T[],
  complete: boolean,
): { group: RowGroup<T>; total: number | null }[] {
  const merged = new Map<string, RowGroup<T>>();
  // A row two repositories both answered with shows once, where it first came.
  const seen = new Set<string>();
  const fresh = (rows: readonly T[]) =>
    rows.filter((row) => !seen.has(key(row)) && Boolean(seen.add(key(row))));
  for (const list of lists)
    for (const group of list.groups) {
      const kept = merged.get(group.id);
      if (kept) kept.rows.push(...fresh(group.rows));
      else merged.set(group.id, { id: group.id, label: group.label, rows: fresh(group.rows) });
    }
  if (lists.length > 1) for (const group of merged.values()) group.rows = order(group.rows);
  const totalOf = (id: string) => {
    if (!complete) return null;
    let sum = 0;
    for (const list of lists) {
      const count = list.totals?.[id];
      if (count === undefined) return null;
      sum += count;
    }
    return sum;
  };
  return [...merged.values()].map((group) => ({ group, total: totalOf(group.id) }));
}
