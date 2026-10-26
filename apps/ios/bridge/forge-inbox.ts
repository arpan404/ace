import {
  ForgeInboxThreadId,
  ForgeRepository,
  WorkspaceId,
  type ForgeInboxList,
  type ForgeInboxRow,
  type ForgeInboxWrite,
} from "@ace/protocol";
import {
  actionErrorText,
  inboxReasonWords,
  inboxTarget,
  inboxTypeWords,
  issueStateMark,
  prTone,
  prWords,
  type ForgeMark,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * The person's GitHub notifications on the phone, as the web's Inbox shows them: unread (or all)
 * newest first, one row per thread, each with its subject's state, why it arrived, and where it
 * opens: ace's own pull request or issue page, else GitHub. Mark read, done and unsubscribe go
 * through their own `gh`; each sets a state, so one GitHub didn't confirm is safe to send again,
 * but only when the person asks.
 */

export const ForgeInboxRequest = z.object({
  type: z.literal("forge.inbox"),
  project: z.string().min(1).max(512),
  all: z.boolean().default(false),
  participating: z.boolean().default(false),
  /** GitHub's reason word to keep; every reason when absent. */
  reason: z.string().min(1).max(64).optional(),
  /** How many pages of 50 to show. */
  screens: z.number().int().min(1).max(20).default(1),
});
export type ForgeInboxRequest = z.infer<typeof ForgeInboxRequest>;

export const ForgeInboxWriteRequest = z.object({
  type: z.literal("forge.inbox.write"),
  project: z.string().min(1).max(512),
  action: z.enum(["read", "done", "unsubscribe"]),
  id: ForgeInboxThreadId,
});
export type ForgeInboxWriteRequest = z.infer<typeof ForgeInboxWriteRequest>;

export interface InboxRowView {
  id: string;
  title: string;
  /** "acme/ace". */
  repository: string;
  number: number | null;
  /** The subject's type in words, for anything that isn't a pull request or issue. */
  type: string;
  /** `pull` or `issue` for their glyphs; null for other subjects. */
  glyph: "pull" | "issue" | null;
  state: ForgeMark | null;
  merged: boolean;
  reason: string;
  unread: boolean;
  updatedAt: number | null;
  /** Opens in the app: its kind and number, and its repository when not the project's. */
  opens: { kind: "pull" | "issue"; number: number; repository: ForgeRepository | null } | null;
  /** Where it opens on GitHub otherwise. */
  url: string;
}
export interface InboxReply {
  type: "forge.inbox";
  rows: InboxRowView[];
  more: boolean;
  /** The reasons the filter offers: GitHub's usual ones and any these rows name. */
  reasons: { value: string; label: string }[];
}

const same = (a: ForgeRepository, b: ForgeRepository | undefined) =>
  !!b && a.host === b.host && a.owner === b.owner && a.name === b.name;
const epoch = (at: string) => {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
};

function rowView(row: ForgeInboxRow, page: ForgeInboxList, preview: Preview): InboxRowView {
  const target = inboxTarget(row);
  const pull = row.type === "PullRequest";
  const issue = row.type === "Issue";
  const state =
    pull && row.state
      ? { word: prWords[row.state], tone: prTone[row.state] }
      : issue && (row.state === "open" || row.state === "closed")
        ? issueStateMark(row.state)
        : null;
  return {
    id: row.id,
    title: preview(row.title, 400),
    repository: `${row.repository.owner}/${row.repository.name}`,
    number: row.number ?? null,
    type: inboxTypeWords(row.type),
    glyph: pull ? "pull" : issue ? "issue" : null,
    state,
    merged: row.state === "merged",
    reason: inboxReasonWords(row.reason),
    unread: row.unread,
    updatedAt: epoch(row.updatedAt),
    opens:
      target.kind === "web"
        ? null
        : {
            kind: target.kind,
            number: target.number,
            repository: same(row.repository, page.projectRepository) ? null : row.repository,
          },
    url:
      target.kind === "web"
        ? target.url
        : (row.url ??
          `https://${row.repository.host}/${row.repository.owner}/${row.repository.name}`),
  };
}

export async function readInbox(
  reads: ForgeReads,
  request: ForgeInboxRequest,
  preview: Preview,
): Promise<InboxReply> {
  const rows: InboxRowView[] = [];
  const seen = new Set<string>();
  const reasons = new Set<string>();
  let more = false;
  for (let page = 1; page <= request.screens; page++) {
    const value = await reads.read(
      {
        op: "forge.inbox.list",
        workspaceId: request.project,
        query: { all: request.all, participating: request.participating, page },
      },
      false,
    );
    if (value.resource !== "inboxList") throw new ForgeRefusal("forge_invalid_data");
    for (const row of value.value.items) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      reasons.add(row.reason);
      if (!request.reason || row.reason === request.reason)
        rows.push(rowView(row, value.value, preview));
    }
    more = value.value.nextPage !== undefined;
    if (!more) break;
  }
  if (request.reason) reasons.add(request.reason);
  return {
    type: "forge.inbox",
    rows,
    more,
    reasons: [...reasons].map((value) => ({ value, label: inboxReasonWords(value) })),
  };
}

export interface InboxWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  /** GitHub didn't confirm it: it may have gone through, and sending it again is safe. */
  uncertain: boolean;
}

export async function writeInbox(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeInboxWriteRequest,
): Promise<InboxWriteReply> {
  const input: ForgeInboxWrite = { action: request.action, id: request.id };
  const unconfirmed: InboxWriteReply = {
    type: "forge.write",
    ok: false,
    message: "GitHub didn't confirm it. It may have gone through; sending it again is safe.",
    uncertain: true,
  };
  try {
    const result = await owner.command({
      type: "forge.inbox.write",
      workspaceId: WorkspaceId.parse(request.project),
      input,
    });
    reads.forget(request.project);
    if (result.ok) return { type: "forge.write", ok: true, message: "", uncertain: false };
    if (result.inboxAction?.state === "uncertain" || result.error === "action_outcome_uncertain")
      return unconfirmed;
    return {
      type: "forge.write",
      ok: false,
      message: actionErrorText(result.error),
      uncertain: false,
    };
  } catch {
    reads.forget(request.project);
    return unconfirmed;
  }
}
