import { ForgeRepository, type ForgeIssueDetail, type ForgePrDetail } from "@ace/protocol";
import {
  completionAt,
  completionChange,
  issueParticipants,
  prParticipants,
  rankPeople,
  referenceMatches,
  referenceSearch,
  reviewerRows,
  reviewerWords,
  searchable,
  suggestedReviewers,
  type CompletionPerson,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { scopeOf } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * People on the phone's pull requests and issues: `@` and `#` completion in every editor, by
 * the web's rules (`text-completions`), and a pull request's reviewers with what this account
 * may ask of each (`forge-reviewers`). Searches are kept half a minute, as lists are, so typing
 * doesn't ask GitHub on every key.
 */

const target = {
  project: z.string().min(1).max(512),
  repository: ForgeRepository.optional(),
};
export const ForgeCompleteRequest = z.object({
  type: z.literal("forge.complete"),
  ...target,
  /** The pull request or issue the editor writes on: its people come first. */
  on: z.object({ kind: z.enum(["pull", "issue"]), number: z.number().int().positive() }).optional(),
  text: z.string().max(66_000),
  /** The selection, in UTF-16 offsets. */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type ForgeCompleteRequest = z.infer<typeof ForgeCompleteRequest>;

export const ForgeReviewersRequest = z.object({
  type: z.literal("forge.pull.reviewers"),
  ...target,
  number: z.number().int().positive(),
});
export type ForgeReviewersRequest = z.infer<typeof ForgeReviewersRequest>;

export interface CompletionItem {
  /** "@mira", "#12". */
  label: string;
  /** A name, or an issue's title. */
  detail: string;
  /** The edit a pick makes, in UTF-16 offsets: replace `from`..`to` with `insert`. */
  from: number;
  to: number;
  insert: string;
  caret: number;
}
export interface CompleteReply {
  type: "forge.complete";
  items: CompletionItem[];
}

export interface ReviewersReply {
  type: "forge.pull.reviewers";
  rows: {
    key: string;
    kind: "user" | "team";
    name: string;
    label: string;
    words: string;
    /** A verdict that counts takes its state's colour. */
    tone: "done" | "failed" | null;
    reviewId: number | null;
    canRerequest: boolean;
    canRemove: boolean;
    canDismiss: boolean;
  }[];
  suggested: { login: string; name: string | null }[];
  canRequest: boolean;
}

async function participants(
  reads: ForgeReads,
  request: ForgeCompleteRequest,
): Promise<CompletionPerson[]> {
  const on = request.on;
  if (!on) return [];
  const scope = scopeOf({ ...request, number: on.number });
  try {
    if (on.kind === "pull") {
      const value = await reads.read({ op: "forge.pr.detail", ...scope }, true);
      return value.resource === "prDetail" ? prParticipants(value.value as ForgePrDetail) : [];
    }
    const value = await reads.read({ op: "forge.issue.detail", ...scope }, true);
    return value.resource === "issueDetail"
      ? issueParticipants(value.value as ForgeIssueDetail, [])
      : [];
  } catch {
    return [];
  }
}

export async function complete(
  reads: ForgeReads,
  request: ForgeCompleteRequest,
  preview: Preview,
): Promise<CompleteReply> {
  const selection = { value: request.text, start: request.start, end: request.end };
  const match = completionAt(selection);
  if (!match) return { type: "forge.complete", items: [] };
  const scope = {
    workspaceId: request.project,
    ...(request.repository ? { repository: request.repository } : {}),
  };
  const item = (label: string, detail: string, text: string): CompletionItem => {
    const change = completionChange(selection, match, text);
    return {
      label: preview(label, 200),
      detail: preview(detail, 300),
      from: change.from,
      to: change.to,
      insert: change.insert,
      caret: change.select[0],
    };
  };
  if (match.kind === "mention") {
    const query = searchable(match.query);
    const found = await reads
      .read({ op: "forge.people", ...scope, query }, true)
      .then((value) => (value.resource === "people" ? value.people : []))
      // The conversation's own people still answer when the repository's can't be read.
      .catch(() => []);
    const people = rankPeople(await participants(reads, request), found, query);
    return {
      type: "forge.complete",
      items: people.map((person) =>
        item(`@${person.login}`, person.name ?? "", `@${person.login}`),
      ),
    };
  }
  const sent = searchable(referenceSearch(match.query));
  const value = await reads.read({ op: "forge.references", ...scope, query: sent }, true);
  const typed = searchable(match.query);
  const references = value.resource === "references" ? value.references : [];
  return {
    type: "forge.complete",
    items: references
      .filter((reference) => referenceMatches(reference, typed))
      .slice(0, 8)
      .map((reference) => item(`#${reference.number}`, reference.title, `#${reference.number}`)),
  };
}

export async function readReviewers(
  reads: ForgeReads,
  request: ForgeReviewersRequest,
  preview: Preview,
): Promise<ReviewersReply> {
  const value = await reads.read({ op: "forge.pr.reviewers", ...scopeOf(request) }, false);
  if (value.resource !== "prReviewers") throw new ForgeRefusal("forge_invalid_data");
  const reviewers = value.value;
  return {
    type: "forge.pull.reviewers",
    rows: reviewerRows(reviewers).map((row) => ({
      key: row.key,
      kind: row.kind,
      name: row.name,
      label: preview(row.label, 256),
      words: reviewerWords(row),
      tone:
        row.review?.state === "APPROVED"
          ? "done"
          : row.review?.state === "CHANGES_REQUESTED"
            ? "failed"
            : null,
      reviewId: row.review?.id ?? null,
      canRerequest: row.canRerequest,
      canRemove: row.canRemove,
      canDismiss: row.canDismiss,
    })),
    suggested: reviewers.canRequest
      ? suggestedReviewers(reviewers).map((person) => ({
          login: person.login,
          name: person.name ? preview(person.name, 256) : null,
        }))
      : [],
    canRequest: reviewers.canRequest,
  };
}
