import type {
  ForgeRepository,
  ForgeIssueList,
  ForgeIssueRow,
  ForgePrList,
  ForgePrRow,
  ForgePrSearch,
} from "@ace/protocol";
import {
  can,
  groupBySteps,
  groupIssues,
  groupPrs,
  issueQuery,
  nextReadyRead,
  prQuery,
  readinessQueries,
  rowStep,
  sortPrs,
  type ReadyRead,
  type RowGroup,
  type RowStep,
  repositoryLabel,
  repositoryCapabilities,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import {
  issueListSources,
  mergeGroups,
  pullSources,
  readEach,
  type ListSource,
} from "./forge-list-sources.ts";
import type { MergePick } from "./forge-merge-run.ts";
import type { ForgeReads } from "./forge-reads.ts";
import {
  filterChoices,
  issueRowView,
  keyOf,
  prRowView,
  type ForgeGroupView,
  type IssueRowView,
  type PrRowView,
} from "./forge-rows.ts";

/*
 * The Pull requests and Issues lists, read as the web's pages read them: the same searches,
 * the "Ready to merge" order read across the whole repository readiest first, the same groups
 * and GitHub's totals for them. A project with several repositories reads each and shows them as
 * one list (`forge-list-sources.ts`). One service call answers one screenful; "Show more" asks
 * again with one more.
 */

const login = z
  .string()
  .regex(/^[\w-]*$/)
  .max(100);
const labels = z.array(z.string().min(1).max(100)).max(20);
const query = z.string().max(256);
export const PullsSearch = z.object({
  who: z.enum(["all", "authored", "reviewing"]).optional(),
  state: z.enum(["open", "merged", "closed", "all"]).optional(),
  sort: z.enum(["ready", "updated", "largest", "smallest"]).optional(),
  draft: z.enum(["only", "hide"]).optional(),
  review: z.enum(["approved", "changes", "required", "none"]).optional(),
  checks: z.enum(["passing", "failing"]).optional(),
  author: login.optional(),
  labels: labels.optional(),
  q: query.optional(),
});
export const IssuesSearch = z.object({
  who: z.enum(["all", "assigned", "created"]).optional(),
  state: z.enum(["open", "closed"]).optional(),
  sort: z.enum(["updated", "created", "comments"]).optional(),
  author: login.optional(),
  labels: labels.optional(),
  q: query.optional(),
});
const projectId = z.string().min(1).max(512);
const screens = z.number().int().min(1).max(8).default(1);
export const ForgeListRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pulls"), project: projectId, search: PullsSearch, screens }),
  z.object({ type: z.literal("forge.issues"), project: projectId, search: IssuesSearch, screens }),
]);
export type ForgeListRequest = z.infer<typeof ForgeListRequest>;

/** Rows per screen, as the web's pages: one page's worth, then one more per "Show more". */
const screenful = 25;

/** A row's repository, named only when the project lists more than one. */
interface Labelled {
  repositoryLabel: string | null;
}
/** A ready row can be picked for one verified merge (`forge-merge-run.ts`), pinned to its head. */
interface Pickable {
  mergePick: MergePick | null;
}

export interface PullsReply {
  type: "forge.pulls";
  repository: string;
  /** Each state's count for the State choice: open includes drafts. */
  counts: { open: number; merged: number; closed: number } | null;
  groups: ForgeGroupView<PrRowView & Labelled & Pickable>[];
  more: boolean;
  /** One sentence per repository that couldn't be read; the others' rows still show. */
  failed: string[];
  authors: string[];
  labels: string[];
}
export interface IssuesReply {
  type: "forge.issues";
  repository: string;
  counts: { open: number; closed: number } | null;
  groups: ForgeGroupView<IssueRowView & Labelled>[];
  more: boolean;
  failed: string[];
  authors: string[];
  labels: string[];
  canCreate: boolean;
  /** The repository New issue opens on (the primary, as the web's): null where it can't. */
  createOn: ForgeRepository | null;
}

const identity = (row: ForgePrRow) => keyOf(row);
const unique = (rows: readonly ForgePrRow[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(identity(row)) && seen.add(identity(row)));
};

async function readPages<L extends ForgePrList | ForgeIssueList>(
  read: (page: number) => Promise<L>,
  pages: number,
): Promise<{ first: L; rows: L["items"]; more: boolean }> {
  const first = await read(1);
  const rows: L["items"][number][] = [...first.items];
  let last: L = first;
  for (let page = 2; page <= pages && last.nextPage !== undefined; page++) {
    last = await read(last.nextPage);
    rows.push(...last.items);
  }
  return { first, rows, more: last.nextPage !== undefined };
}

/**
 * "Ready to merge" across a repository: one whose open PRs fit one page is ranked from it; a
 * larger one is read through the readiness searches until `target` rows show.
 */
async function readReady(
  read: (query: ForgePrSearch, page: number) => Promise<ForgePrList>,
  search: z.infer<typeof PullsSearch>,
  head: ForgePrList,
  target: number,
): Promise<{ rows: ForgePrRow[]; more: boolean }> {
  if (head.nextPage === undefined) return { rows: head.items, more: false };
  const queries = readinessQueries(search);
  const steps: ReadyRead[] = [];
  const answers: ForgePrList[] = [];
  let rows: ForgePrRow[] = [];
  for (;;) {
    const step = nextReadyRead(steps, answers, queries.length);
    if (!step || rows.length >= target) break;
    steps.push(step);
    answers.push(await read(queries[step.query] ?? prQuery(search, 1), step.page));
    rows = unique(answers.flatMap((answer) => answer.items));
  }
  return { rows, more: nextReadyRead(steps, answers, queries.length) !== undefined };
}

/** One repository's pull requests, grouped by its own viewer, with its group totals. */
async function readRepositoryPulls(
  reads: ForgeReads,
  request: Extract<ForgeListRequest, { type: "forge.pulls" }>,
  source: ListSource,
) {
  const { project, search } = request;
  const base: ForgePrSearch = prQuery(search, 1);
  const sort = search.sort ?? "ready";
  const byReadiness = sort === "ready" && (search.state ?? "open") === "open";
  const read = (pageQuery: ForgePrSearch, page: number) =>
    reads.prPage(project, pageQuery, page, source.repository);
  const listed = byReadiness
    ? undefined
    : await readPages((page) => read(base, page), request.screens);
  const first = listed?.first ?? (await read(base, 1));
  const ranked = byReadiness
    ? await readReady(read, search, first, screenful * request.screens)
    : undefined;
  const rows = ranked?.rows ?? listed?.rows ?? [];
  const more = ranked?.more ?? listed?.more ?? false;
  const linked = reads.linked().pulls;
  const steps = new Map(
    rows.map((row) => [
      identity(row),
      rowStep(row, first.viewer, linked.get(identity(row)), [], source.capabilitySource),
    ]),
  );
  const groups: RowGroup<ForgePrRow>[] = byReadiness
    ? groupBySteps(rows, (row) => steps.get(identity(row))?.step ?? "wait")
    : groupPrs(sortPrs(rows, sort === "ready" ? "updated" : sort), first.viewer);
  // Next-step groups have no GitHub totals: they count their rows once every page is read.
  const totals = byReadiness
    ? undefined
    : await reads
        .groupCounts(project, { by: "pr-people", query: base }, source.repository)
        .catch(() => undefined);
  return { first, rows, more, steps, groups, totals };
}

export async function readPulls(
  reads: ForgeReads,
  request: Extract<ForgeListRequest, { type: "forge.pulls" }>,
  preview: Preview,
): Promise<PullsReply> {
  const { search } = request;
  const sort = search.sort ?? "ready";
  const byReadiness = sort === "ready" && (search.state ?? "open") === "open";
  const { sources, unlisted, entries } = await pullSources(reads, request.project);
  const { answers, failed } = await readEach(sources, (source) =>
    readRepositoryPulls(reads, request, source),
  );
  const lists = answers.map((answer) => answer.value);
  const more = lists.some((list) => list.more);
  // Counts are known only once every repository answered in full, so none undercounts.
  const complete = answeredInFull(sources, lists, unlisted);
  const linked = reads.linked().pulls;

  const labelled = sources.some((source) => source.label);
  const steps = new Map<string, RowStep>();
  for (const list of lists)
    for (const [key, step] of list.steps) if (!steps.has(key)) steps.set(key, step);
  const stepOf = (row: ForgePrRow) =>
    steps.get(identity(row)) ?? { step: "wait" as const, local: undefined };
  const merged = mergeGroups(
    lists,
    identity,
    (rows) =>
      byReadiness
        ? groupBySteps(rows, (row) => stepOf(row).step).flatMap((group) => group.rows)
        : sortPrs(rows, sort === "ready" ? "updated" : sort),
    complete,
  );
  const first = lists[0]?.first;
  return {
    type: "forge.pulls",
    repository: first ? `${first.repository.owner}/${first.repository.name}` : "",
    counts: complete
      ? {
          open: total(lists, ({ first: head }) => head.counts.open + head.counts.draft),
          merged: total(lists, ({ first: head }) => head.counts.merged),
          closed: total(lists, ({ first: head }) => head.counts.closed),
        }
      : null,
    groups: merged.map(({ group, total }) => ({
      id: group.id,
      label: group.label,
      count: byReadiness ? (more || !complete ? null : group.rows.length) : total,
      rows: group.rows.map((row) => {
        const source = repositoryCapabilities(row.ref.repository, entries);
        return {
          ...prRowView(row, stepOf(row), linked, preview, source),
          repositoryLabel: labelled ? repositoryLabel(row.ref.repository) : null,
          // As the web's list: by next step, a ready row with a known head merges verified.
          mergePick:
            byReadiness &&
            stepOf(row).step === "merge" &&
            can(source, "reviews.merge") &&
            row.headSha &&
            row.baseBranch
              ? {
                  key: identity(row),
                  repository: row.ref.repository,
                  number: row.ref.number,
                  headSha: row.headSha,
                  base: row.baseBranch,
                  title: preview(row.title, 512),
                }
              : null,
        };
      }),
    })),
    more,
    failed: unlisted ? [unlisted, ...failed] : failed,
    ...filterChoices(
      lists.flatMap((list) => list.rows),
      search,
    ),
  };
}

export async function readIssues(
  reads: ForgeReads,
  request: Extract<ForgeListRequest, { type: "forge.issues" }>,
  preview: Preview,
): Promise<IssuesReply> {
  const { project, search } = request;
  const base = issueQuery(search, 1);
  const { sources, unlisted } = await issueListSources(reads, project);
  const { answers, failed } = await readEach(sources, async (source) => {
    const pages = await readPages(
      (page) => reads.issuePage(project, base, page, source.repository),
      request.screens,
    );
    const totals = await reads
      .groupCounts(project, { by: "issue-people", query: base }, source.repository)
      .catch(() => undefined);
    return { ...pages, groups: groupIssues(pages.rows, pages.first.viewer), totals };
  });
  const lists = answers.map((answer) => answer.value);
  const labelled = sources.some((source) => source.label);
  const linked = reads.linked().issues;
  const first = lists[0]?.first;
  const complete = answeredInFull(sources, lists, unlisted);
  const primary = answers.find((answer) => answer.source.repository === undefined);
  const creatable =
    !!primary?.value.first.canCreate &&
    can(primary.source.capabilitySource ?? primary.value.first.repository, "issues.write");
  return {
    type: "forge.issues",
    repository: first ? `${first.repository.owner}/${first.repository.name}` : "",
    counts: complete
      ? {
          open: total(lists, (list) => list.first.counts.open),
          closed: total(lists, (list) => list.first.counts.closed),
        }
      : null,
    groups: mergeGroups(lists, keyOf, (rows) => rows.toSorted(newestIssue), complete).map(
      ({ group, total }) => ({
        id: group.id,
        label: group.label,
        count: total,
        rows: group.rows.map((row) => ({
          ...issueRowView(row, linked, preview),
          repositoryLabel: labelled ? repositoryLabel(row.ref.repository) : null,
        })),
      }),
    ),
    more: lists.some((list) => list.more),
    failed: unlisted ? [unlisted, ...failed] : failed,
    ...filterChoices(
      lists.flatMap((list) => list.rows),
      search,
    ),
    // New issues open on the primary, which is read without naming it.
    canCreate: creatable,
    createOn: creatable && primary ? primary.value.first.repository : null,
  };
}

const updatedAt = (row: { updatedAt?: string | undefined }) => Date.parse(row.updatedAt ?? "") || 0;
const newestIssue = (a: ForgeIssueRow, b: ForgeIssueRow) => updatedAt(b) - updatedAt(a);

/**
 * Every source answered, its repositories were all known, and no first page says its counts
 * are partial: only then are counts summed.
 */
const answeredInFull = (
  sources: readonly ListSource[],
  lists: readonly { first: ForgePrList | ForgeIssueList }[],
  unlisted: string | null,
) =>
  !unlisted &&
  lists.length === sources.length &&
  lists.every(({ first }) => !first.incomplete && !first.truncated);

/** A state's count added across repositories. */
const total = <T>(lists: readonly T[], count: (list: T) => number) =>
  lists.reduce((sum, list) => sum + count(list), 0);
