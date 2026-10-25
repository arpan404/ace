import { ForgeRepository, type ForgeFile, type ForgePrFiles } from "@ace/protocol";
import { lockedText } from "@ace/ui-core";
import { mobileFileDiff, type MobileDiffLine } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { Preview } from "./agents.ts";
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
 * conversations no shown line holds, and whether this account can comment on a line.
 */

export const ForgeFileRequest = z.object({
  type: z.literal("forge.pull.file"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  path: z.string().min(1).max(4096),
  /** Where the file sits in the PR's list, so its page is read first. */
  index: z.number().int().nonnegative().max(100_000).optional(),
});
export type ForgeFileRequest = z.infer<typeof ForgeFileRequest>;

export interface LineView extends MobileDiffLine {
  /** Where a comment on this line anchors; null for a hunk header. */
  anchor: { line: number; side: "LEFT" | "RIGHT" } | null;
  threads: ThreadView[];
  drafts: { id: string; body: string }[];
}
export interface FileReply {
  type: "forge.pull.file";
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
}

const pageSize = 25;
const maxPages = 8;

async function filePage(
  reads: ForgeReads,
  target: PrTarget,
  page: number,
  shas: { headSha: string; baseSha: string },
): Promise<ForgePrFiles> {
  const value = await reads.read({ op: "forge.pr.files", ...scopeOf(target), page, ...shas }, true);
  if (value.resource !== "prFiles") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

/** The file's page: the one its place in the list names first, then the others in order. */
async function findFile(
  reads: ForgeReads,
  request: ForgeFileRequest,
  shas: { headSha: string; baseSha: string },
): Promise<ForgeFile> {
  const first = request.index === undefined ? 1 : Math.floor(request.index / pageSize) + 1;
  const pages = [
    first,
    ...Array.from({ length: maxPages }, (_, i) => i + 1).filter((p) => p !== first),
  ];
  for (const page of pages) {
    const value = await filePage(reads, request, page, shas);
    const file = value.files.find((each) => each.path === request.path);
    if (file) return file;
    if (value.nextPage === undefined && page >= first) break;
  }
  throw new ForgeRefusal("forge_not_found");
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
  const [file, state, lifecycle] = await Promise.all([
    findFile(reads, request, shas),
    prReviewState(reads, request),
    prLifecycle(reads, request),
  ]);
  const locked = lockedOut(lifecycle);
  const conversation: Conversation = { state, url: detail.status.url, locked, preview, shown };
  const diff = mobileFileDiff(file.patch ?? "", file.truncated, undefined, preview);
  const threads = detail.status.reviewThreads.filter((thread) => thread.file === file.path);
  const placed = new Set<string>();
  const drafts = (state?.drafts ?? []).filter((draft) => draft.anchor.path === file.path);
  const lines = diff.lines.map((line): LineView => {
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
      state && live && (state.canComment || locked) ? { off: locked ? lockedText : null } : null,
    pending: state?.drafts.length ?? 0,
    headSha: detail.status.headSha,
  };
}
