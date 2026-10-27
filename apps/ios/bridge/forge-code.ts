import { ForgeRepository, type ForgeFile, type ForgePrFiles } from "@ace/protocol";
import {
  codeCaveats,
  hostedFileShow,
  lockedText,
  renderedKind,
  splitPairs,
  viewedMarks,
  type HostedFileShow,
  type ViewedState,
} from "@ace/ui-core";
import { mobileFileDiff, type MobileDiffLine } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRange, prCommitHistory, rangeLabel } from "./forge-commits.ts";
import {
  threadView,
  type Conversation,
  type ShownBodies,
  type ThreadView,
} from "./forge-conversation.ts";
import {
  lockedOut,
  prDetail,
  prLifecycle,
  prReviewState,
  scopeOf,
  type PrTarget,
} from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * One changed file of a pull request as the phone's Code view shows it: its diff lines within
 * the phone's budget, each line's conversations and pending review comments under it, the
 * conversations no shown line holds, and whether this account can comment on a line. A range
 * (one commit, or what changed after an earlier one) shows its own diff only: conversations
 * and new comments belong to All commits at the head, as on the web.
 */

export const ForgeFileRequest = z.object({
  type: z.literal("forge.pull.file"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  path: z.string().min(1).max(4096),
  /** Where the file sits in the PR's list, so its page is read first. */
  index: z.number().int().nonnegative().max(100_000).optional(),
  range: ForgeRange.optional(),
});
export type ForgeFileRequest = z.infer<typeof ForgeFileRequest>;

export const ForgeFilesRequest = z.object({
  type: z.literal("forge.pull.files"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  range: ForgeRange.optional(),
});
export type ForgeFilesRequest = z.infer<typeof ForgeFilesRequest>;

/** A file's Viewed mark: `changed` once it was pushed to after it was viewed. */
export type ViewedMark = "viewed" | "changed" | "unviewed";
const markOf = (state: ViewedState | undefined): ViewedMark | null =>
  state ? (state.checked ? "viewed" : state.changed ? "changed" : "unviewed") : null;

export interface FilesReply {
  type: "forge.pull.files";
  /** The PR's head, which a Viewed mark is set at. */
  headSha: string;
  /** The range shown and its words; null for All commits. */
  range: { commit: string; since: string | null; label: string } | null;
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    conversations: number;
    /** Null where the range shown carries no marks. */
    viewed: ViewedMark | null;
  }[];
  /** How many files are viewed; null when the marks are unknown or don't apply. */
  viewedCount: number | null;
  /** What can't be shown in full, as sentences. */
  caveats: string[];
  /** More files than the phone lists; the rest are on GitHub. */
  more: boolean;
}

export interface LineView extends MobileDiffLine {
  /** Where a comment on this line anchors; null for a hunk header. */
  anchor: { line: number; side: "LEFT" | "RIGHT" } | null;
  /**
   * Which change of the patch it is in, counted from 0. Lines of one change on one side are
   * numbered without gaps, so any span of them is a range GitHub takes a comment on.
   */
  hunk: number;
  threads: ThreadView[];
  drafts: { id: string; body: string }[];
}
export interface FileReply {
  type: "forge.pull.file";
  number: number;
  repository: ForgeRepository;
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  lines: LineView[];
  hiddenLines: number;
  truncated: boolean;
  /** GitHub shows no lines for it (binary, too large, a rename alone). */
  empty: boolean;
  /** Conversations on this file that no shown line holds: outdated, or past the budget. */
  outside: ThreadView[];
  /** Line comments: null where this account can't comment; `off` says why it can't now. */
  commenting: { off: string | null } | null;
  /** Line comments already waiting in the review. */
  pending: number;
  headSha: string;
  /** How the file draws: its patch, or both sides read whole (an image, or a withheld text). */
  show: HostedFileShow;
  /** A Markdown file that can also be drawn as it reads. */
  rendered: boolean;
  /** Side by side: the line indexes on the left and right of each row, null for an empty half. */
  pairs: [number | null, number | null][];
  viewed: ViewedMark | null;
  /** The exact commits this diff is between, which its rendered and image views read too. */
  revisions: FileRevisions;
}

/**
 * The commits a file's diff is between (content at a commit never changes), the PR's head it
 * was read at (where a Viewed mark is set), and where the file lives on each side.
 */
const revisionSha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const FileRevisions = z.object({
  base: revisionSha,
  head: revisionSha,
  prHead: revisionSha,
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).nullable(),
  status: z.string().max(32),
});
export type FileRevisions = z.infer<typeof FileRevisions>;

const pageSize = 25;
const maxPages = 8;

async function filePage(
  reads: ForgeReads,
  target: PrTarget,
  page: number,
  shas: { headSha: string; baseSha: string },
  range: ForgeRange | undefined,
): Promise<ForgePrFiles> {
  const value = await reads.read(
    {
      op: "forge.pr.files",
      ...scopeOf(target),
      page,
      ...shas,
      ...(range ? { commit: range.commit } : {}),
      ...(range?.since ? { since: range.since } : {}),
    },
    true,
  );
  if (value.resource !== "prFiles") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

/**
 * The file's page: the one its place in the list names first, then the others in order. The
 * file comes with the two commits its diff is between.
 */
export async function findFile(
  reads: ForgeReads,
  request: Pick<ForgeFileRequest, "project" | "number" | "repository" | "path" | "index" | "range">,
  shas: { headSha: string; baseSha: string },
): Promise<{ file: ForgeFile; baseSha: string; headSha: string }> {
  const first = request.index === undefined ? 1 : Math.floor(request.index / pageSize) + 1;
  const pages = [
    first,
    ...Array.from({ length: maxPages }, (_, i) => i + 1).filter((p) => p !== first),
  ];
  for (const page of pages) {
    const value = await filePage(reads, request, page, shas, request.range);
    const file = value.files.find((each) => each.path === request.path);
    if (file) return { file, baseSha: value.baseSha, headSha: value.headSha };
    if (value.nextPage === undefined && page >= first) break;
  }
  throw new ForgeRefusal("forge_not_found");
}

/** The changed files in GitHub's order, each with its open conversations, up to eight pages. */
export async function readFiles(
  reads: ForgeReads,
  request: ForgeFilesRequest,
  preview: Preview,
): Promise<FilesReply> {
  const detail = await prDetail(reads, request);
  const headSha = detail.status.headSha;
  const shas = { headSha, baseSha: detail.baseSha };
  const { range } = request;
  const [state, history] = await Promise.all([
    prReviewState(reads, request),
    // A range is named by its commits' titles; a missing list leaves their short hashes.
    range
      ? prCommitHistory(reads, request, headSha).catch(() => ({ commits: [], truncated: false }))
      : undefined,
  ]);
  const files: ForgeFile[] = [];
  let page: number | undefined = 1;
  let truncated = false;
  while (page !== undefined && page <= maxPages) {
    const value: ForgePrFiles = await filePage(reads, request, page, shas, range);
    files.push(...value.files);
    truncated ||= value.truncated;
    page = value.nextPage;
  }
  const marks = viewedMarks(state, range ? { headSha, commit: range.commit } : { headSha });
  // Conversations belong to All commits: a range shows its own diff alone.
  const open = range ? [] : detail.status.reviewThreads.filter((thread) => !thread.resolved);
  return {
    type: "forge.pull.files",
    headSha,
    range: range
      ? {
          commit: range.commit,
          since: range.since ?? null,
          label: preview(rangeLabel(range, history?.commits ?? []), 512),
        }
      : null,
    files: files.map((file) => ({
      path: preview(file.path, 4_096),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      conversations: open.filter((thread) => thread.file === file.path).length,
      viewed: markOf(marks.of(file.path)),
    })),
    viewedCount: marks.count ?? null,
    caveats: codeCaveats({
      viewed: state ? marks.availability : "unavailable",
      truncated,
      commitsTruncated: history?.truncated ?? false,
    }),
    more: page !== undefined,
  };
}

const anchorOf = (line: MobileDiffLine): LineView["anchor"] =>
  line.kind === "hunk"
    ? null
    : line.kind === "del"
      ? line.old === null
        ? null
        : { line: line.old, side: "LEFT" }
      : line.new === null
        ? null
        : { line: line.new, side: "RIGHT" };

export async function readFile(
  reads: ForgeReads,
  request: ForgeFileRequest,
  preview: Preview,
  shown: ShownBodies,
): Promise<FileReply> {
  const detail = await prDetail(reads, request);
  const shas = { headSha: detail.status.headSha, baseSha: detail.baseSha };
  const [found, state, lifecycle] = await Promise.all([
    findFile(reads, request, shas),
    prReviewState(reads, request),
    prLifecycle(reads, request),
  ]);
  const { file } = found;
  const locked = lockedOut(lifecycle);
  const conversation: Conversation = {
    state,
    url: detail.status.url,
    repository: detail.status.ref.repository,
    locked,
    preview,
    shown,
  };
  const { range } = request;
  const diff = mobileFileDiff(file.patch ?? "", file.truncated, undefined, preview);
  // Conversations, pending comments and new ones belong to All commits at the head.
  const threads = range
    ? []
    : detail.status.reviewThreads.filter((thread) => thread.file === file.path);
  const placed = new Set<string>();
  const drafts = range
    ? []
    : (state?.drafts ?? []).filter((draft) => draft.anchor.path === file.path);
  let hunk = -1;
  const lines = diff.lines.map((line): LineView => {
    if (line.kind === "hunk" || hunk < 0) hunk++;
    const anchor = anchorOf(line);
    const here = anchor
      ? threads.filter(
          (thread) =>
            !thread.outdated &&
            thread.line === anchor.line &&
            (thread.side ?? "RIGHT") === anchor.side,
        )
      : [];
    for (const thread of here) placed.add(thread.id);
    return {
      ...line,
      anchor,
      hunk,
      threads: here.map((thread) => threadView(conversation, thread)),
      drafts: anchor
        ? drafts
            .filter(
              (draft) => draft.anchor.line === anchor.line && draft.anchor.side === anchor.side,
            )
            .map((draft) => ({ id: draft.id, body: preview(draft.body, 8_192) }))
        : [],
    };
  });
  const live = detail.status.state === "open" || detail.status.state === "draft";
  return {
    type: "forge.pull.file",
    number: detail.status.ref.number,
    repository: detail.status.ref.repository,
    path: preview(file.path, 4_096),
    previousPath: file.previousPath ? preview(file.previousPath, 4_096) : null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    lines,
    hiddenLines: diff.hiddenLines,
    truncated: diff.truncated,
    empty: diff.empty,
    outside: threads
      .filter((thread) => !placed.has(thread.id))
      .map((thread) => threadView(conversation, thread)),
    commenting:
      !range && state && live && (state.canComment || locked)
        ? { off: locked ? lockedText : null }
        : null,
    pending: state?.drafts.length ?? 0,
    headSha: detail.status.headSha,
    show: hostedFileShow(file),
    rendered: renderedKind(file.path) === "markdown",
    pairs: splitPairs(lines.map((line) => line.kind)).map(({ left, right }) => [left, right]),
    viewed: markOf(
      viewedMarks(
        state,
        range
          ? { headSha: detail.status.headSha, commit: range.commit }
          : { headSha: detail.status.headSha },
      ).of(file.path),
    ),
    revisions: {
      base: found.baseSha,
      head: found.headSha,
      prHead: detail.status.headSha,
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
    },
  };
}
