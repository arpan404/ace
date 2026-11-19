import {
  ForgeIssueSearch,
  ForgePrSearch,
  ForgeRepository,
  type ForgeIssueRow,
  type ForgePrRow,
} from "@ace/protocol";
import {
  issueRows,
  issueSourceText,
  prSourceText,
  pullRequestRows,
  startRowLimit,
  type StartRow,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * What a new thread can start from, as the web's New thread lists under its composer: the
 * project's open pull requests (failing checks first) and open issues, one GitHub query for
 * both (`forge.open-work`), searched on GitHub when the person types. Picking one gives the
 * draft its first message and its link: a pull request's head for the thread's worktree, or the
 * issue it works on. A project without a forge, or offline, has nothing to start from.
 */

const project = z.string().min(1).max(512);
const kind = z.enum(["pullRequests", "issues"]);
export const ForgeStartFromRequest = z.object({
  type: z.literal("forge.start-from"),
  project,
  /** One list searched on GitHub; the other keeps its open work. */
  search: z.object({ kind, text: z.string().trim().min(1).max(256) }).optional(),
});
export type ForgeStartFromRequest = z.infer<typeof ForgeStartFromRequest>;
export const ForgeStartFromPickRequest = z.object({
  type: z.literal("forge.start-from.pick"),
  project,
  kind,
  repository: ForgeRepository,
  number: z.number().int().positive(),
});
export type ForgeStartFromPickRequest = z.infer<typeof ForgeStartFromPickRequest>;

export interface StartRowView {
  number: number;
  title: string;
  /** What needs the person about it: "Checks failing", "Draft", an issue's first label. */
  note: { text: string; failed: boolean } | null;
  updatedAt: number | null;
  repository: ForgeRepository;
}
export interface StartListView {
  label: string;
  total: number;
  rows: StartRowView[];
  /** Rows shown before Show more; a longer list can be searched. */
  limit: number;
  /** What an empty or failed search says. */
  none: string;
}
export interface StartFromReply {
  type: "forge.start-from";
  /** Null when there's nothing open to start from (or no forge): the list takes no space. */
  pullRequests: StartListView | null;
  issues: StartListView | null;
}
export interface StartFromPickReply {
  type: "forge.start-from.pick";
  /** The first message, for the person to read over. */
  text: string;
  /** The pull request whose head the thread's worktree checks out. */
  pullRequest: {
    repository: ForgeRepository;
    number: number;
    headSha: string;
    title: string;
  } | null;
  issue: { repository: ForgeRepository; number: number; title: string } | null;
}

function rowsOf<Row extends ForgePrRow | ForgeIssueRow>(
  starts: StartRow[],
  rows: readonly Row[],
  preview: Preview,
): StartRowView[] {
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  return starts.flatMap((start) => {
    const row = byUrl.get(start.url);
    if (!row) return [];
    return [
      {
        number: start.number,
        title: preview(start.title, 300),
        note: start.note
          ? { text: preview(start.note.text, 100), failed: start.note.failed }
          : null,
        updatedAt: start.updatedAt ?? null,
        repository: row.ref.repository,
      },
    ];
  });
}

const list = (label: string, total: number, rows: StartRowView[], none: string): StartListView => ({
  label,
  total,
  rows,
  limit: startRowLimit,
  none,
});

export async function readStartFrom(
  reads: ForgeReads,
  request: ForgeStartFromRequest,
  preview: Preview,
): Promise<StartFromReply> {
  const work = await reads
    .read({ op: "forge.open-work", workspaceId: request.project }, true)
    .then((value) => (value.resource === "openWork" ? value.value : undefined))
    .catch(() => undefined);
  const empty: StartFromReply = { type: "forge.start-from", pullRequests: null, issues: null };
  if (!work) return empty;
  const searched = request.search;
  const prs = async (): Promise<StartListView | null> => {
    if (!work.pullRequests.items.length) return null;
    const none = "No open pull requests match.";
    if (searched?.kind !== "pullRequests") {
      const starts = pullRequestRows(work.pullRequests.items, work.failingPullRequests.items);
      const rows = [...work.failingPullRequests.items, ...work.pullRequests.items];
      return list("Pull requests", work.pullRequests.total, rowsOf(starts, rows, preview), none);
    }
    // A failed search shows no rows rather than the unsearched list it would pass for.
    const found = await reads
      .prPage(request.project, ForgePrSearch.parse({ state: "active", search: searched.text }), 1)
      .catch(() => undefined);
    if (!found)
      return list("Pull requests", work.pullRequests.total, [], "Couldn't search pull requests.");
    const starts = pullRequestRows(found.items);
    return list(
      "Pull requests",
      work.pullRequests.total,
      rowsOf(starts, found.items, preview),
      none,
    );
  };
  const issues = async (): Promise<StartListView | null> => {
    if (!work.issues.items.length) return null;
    const none = "No open issues match.";
    if (searched?.kind !== "issues")
      return list(
        "Issues",
        work.issues.total,
        rowsOf(issueRows(work.issues.items), work.issues.items, preview),
        none,
      );
    const found = await reads
      .issuePage(request.project, ForgeIssueSearch.parse({ search: searched.text }), 1)
      .catch(() => undefined);
    if (!found) return list("Issues", work.issues.total, [], "Couldn't search issues.");
    return list(
      "Issues",
      work.issues.total,
      rowsOf(issueRows(found.items), found.items, preview),
      none,
    );
  };
  const [pullRequests, open] = await Promise.all([prs(), issues()]);
  return { type: "forge.start-from", pullRequests, issues: open };
}

export async function pickStartFrom(
  reads: ForgeReads,
  request: ForgeStartFromPickRequest,
  preview: Preview,
): Promise<StartFromPickReply> {
  const target = {
    project: request.project,
    number: request.number,
    repository: request.repository,
  };
  if (request.kind === "pullRequests") {
    const detail = await prDetail(reads, target);
    const { status } = detail;
    // A pull request whose fork is gone has no head to check out.
    if (!detail.headRepository) throw new ForgeRefusal("forge_not_found");
    return {
      type: "forge.start-from.pick",
      text: preview(
        prSourceText({
          number: status.ref.number,
          title: status.title,
          url: status.url,
          headBranch: detail.headBranch,
          baseBranch: detail.baseBranch,
          body: detail.body,
        }),
        32_768,
      ),
      pullRequest: {
        repository: status.ref.repository,
        number: status.ref.number,
        headSha: status.headSha,
        title: preview(status.title, 300),
      },
      issue: null,
    };
  }
  const value = await reads.read(
    {
      op: "forge.issue.detail",
      workspaceId: request.project,
      repository: request.repository,
      number: request.number,
    },
    false,
  );
  if (value.resource !== "issueDetail") throw new ForgeRefusal("forge_invalid_data");
  const issue = value.value;
  return {
    type: "forge.start-from.pick",
    text: preview(issueSourceText(issue), 32_768),
    pullRequest: null,
    issue: {
      repository: issue.ref.repository,
      number: issue.ref.number,
      title: preview(issue.title, 300),
    },
  };
}
