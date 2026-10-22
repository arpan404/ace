import type { ForgeIssueList, ForgePrList, ForgePrRow, ForgePrSearch } from "@ace/protocol";
import {
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
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
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
 * and GitHub's totals for them. One service call answers one screenful; "Show more" asks again
 * with one more.
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

export interface PullsReply {
  type: "forge.pulls";
  repository: string;
  /** Each state's count for the State choice: open includes drafts. */
  counts: { open: number; merged: number; closed: number } | null;
  groups: ForgeGroupView<PrRowView>[];
  more: boolean;
  authors: string[];
  labels: string[];
}
export interface IssuesReply {
  type: "forge.issues";
  repository: string;
  counts: { open: number; closed: number } | null;
  groups: ForgeGroupView<IssueRowView>[];
  more: boolean;
  authors: string[];
  labels: string[];
  canCreate: boolean;
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
 * "Ready to merge" across the repository: a repository whose open PRs fit one page is ranked
 * from it; a larger one is read through the readiness searches until `target` rows show.
 */
async function readReady(
  reads: ForgeReads,
  project: string,
  search: z.infer<typeof PullsSearch>,
  head: ForgePrList,
  target: number,
): Promise<{ rows: ForgePrRow[]; more: boolean }> {
  if (head.nextPage === undefined) return { rows: head.items, more: false };
  const queries = readinessQueries(search);
  const steps: ReadyRead[] = [];
  const answers: ForgePrList[] = [];
  const read = (step: ReadyRead) =>
    reads.prPage(project, queries[step.query] ?? prQuery(search, 1), step.page);
  let rows: ForgePrRow[] = [];
  for (;;) {
    const step = nextReadyRead(steps, answers, queries.length);
    if (!step || rows.length >= target) break;
    steps.push(step);
    answers.push(await read(step));
    rows = unique(answers.flatMap((answer) => answer.items));
  }
  return { rows, more: nextReadyRead(steps, answers, queries.length) !== undefined };
}

export async function readPulls(
  reads: ForgeReads,
  request: Extract<ForgeListRequest, { type: "forge.pulls" }>,
  preview: Preview,
): Promise<PullsReply> {
  const { project, search } = request;
  const base: ForgePrSearch = prQuery(search, 1);
  const sort = search.sort ?? "ready";
  const byReadiness = sort === "ready" && (search.state ?? "open") === "open";
  const listed = byReadiness
    ? undefined
    : await readPages((page) => reads.prPage(project, base, page), request.screens);
  const first = listed?.first ?? (await reads.prPage(project, base, 1));
  const ranked = byReadiness
    ? await readReady(reads, project, search, first, screenful * request.screens)
    : undefined;
  const rows = ranked?.rows ?? listed?.rows ?? [];
  const more = ranked?.more ?? listed?.more ?? false;
  const linked = reads.linked().pulls;
  const steps = new Map(
    rows.map((row) => [identity(row), rowStep(row, first.viewer, linked.get(identity(row)), [])]),
  );
  const stepOf = (row: ForgePrRow) =>
    steps.get(identity(row)) ?? { step: "wait" as const, local: undefined };
  const groups: RowGroup<ForgePrRow>[] = byReadiness
    ? groupBySteps(rows, (row) => stepOf(row).step)
    : groupPrs(sortPrs(rows, sort === "ready" ? "updated" : sort), first.viewer);
  // Next-step groups have no GitHub totals: they count their rows once every page is read.
  const totals = byReadiness
    ? undefined
    : await reads.groupCounts(project, { by: "pr-people", query: base }).catch(() => undefined);
  return {
    type: "forge.pulls",
    repository: `${first.repository.owner}/${first.repository.name}`,
    counts: {
      open: first.counts.open + first.counts.draft,
      merged: first.counts.merged,
      closed: first.counts.closed,
    },
    groups: groups.map((group) => ({
      id: group.id,
      label: group.label,
      count: byReadiness ? (more ? null : group.rows.length) : (totals?.[group.id] ?? null),
      rows: group.rows.map((row) => prRowView(row, stepOf(row), linked, preview)),
    })),
    more,
    ...filterChoices(rows, search),
  };
}

export async function readIssues(
  reads: ForgeReads,
  request: Extract<ForgeListRequest, { type: "forge.issues" }>,
  preview: Preview,
): Promise<IssuesReply> {
  const { project, search } = request;
  const base = issueQuery(search, 1);
  const { first, rows, more } = await readPages(
    (page) => reads.issuePage(project, base, page),
    request.screens,
  );
  const totals = await reads
    .groupCounts(project, { by: "issue-people", query: base })
    .catch(() => undefined);
  const linked = reads.linked().issues;
  return {
    type: "forge.issues",
    repository: `${first.repository.owner}/${first.repository.name}`,
    counts: first.counts,
    groups: groupIssues(rows, first.viewer).map((group) => ({
      id: group.id,
      label: group.label,
      count: totals?.[group.id] ?? null,
      rows: group.rows.map((row) => issueRowView(row, linked, preview)),
    })),
    more,
    ...filterChoices(rows, search),
    canCreate: first.canCreate,
  };
}
