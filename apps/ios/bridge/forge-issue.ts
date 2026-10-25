import { ForgeRepository, type ForgeIssueRef } from "@ace/protocol";
import { issueSourceText, issueStateMark, type ForgeMark } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";
import { keyOf, type ForgeLabelView } from "./forge-rows.ts";
import type { ShownBodies } from "./forge-conversation.ts";
import { bodyKey } from "./forge-task.ts";
import { repositoryBlocks, type RichBlock } from "./forge-rich.ts";

/*
 * One issue as the phone's page shows it: its state, body, labels and people, the first page
 * of its conversation, its threads, and what a thread started from it opens with (the web's
 * `issueSourceText`) together with the issue it links.
 */

export const ForgeIssueRequest = z.object({
  type: z.literal("forge.issue"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  /** Another repository than the project's own; omitted for the project's. */
  repository: ForgeRepository.optional(),
});
export type ForgeIssueRequest = z.infer<typeof ForgeIssueRequest>;

export interface IssueReply {
  type: "forge.issue";
  number: number;
  repository: ForgeRepository;
  title: string;
  url: string;
  state: ForgeMark;
  author: string;
  createdAt: number | null;
  updatedAt: number | null;
  body: string;
  bodyBlocks: RichBlock[];
  /** The body's task boxes tick and save. */
  tasks: boolean;
  labels: ForgeLabelView[];
  assignees: string[];
  milestone: string | null;
  events: {
    id: string;
    comment: boolean;
    actor: string;
    event: string;
    at: number | null;
    body: string | null;
    blocks: RichBlock[];
  }[];
  /** More conversation than the first page; the rest opens on GitHub. */
  moreEvents: boolean;
  threads: { id: string; title: string; archived: boolean; needsYou: boolean }[];
  /** New thread from this issue: its first message, and the issue it links. */
  start: { text: string; issue: ForgeIssueRef };
}

const epoch = (at: string | null | undefined) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export async function readIssue(
  reads: ForgeReads,
  request: ForgeIssueRequest,
  preview: Preview,
  shown: ShownBodies,
): Promise<IssueReply> {
  const scope = {
    workspaceId: request.project,
    ...(request.repository ? { repository: request.repository } : {}),
    number: request.number,
  };
  const detail = await reads.read({ op: "forge.issue.detail", ...scope }, false);
  if (detail.resource !== "issueDetail") throw new ForgeRefusal("forge_invalid_data");
  const issue = detail.value;
  shown.set(bodyKey("issue", issue.ref.repository, issue.ref.number), issue.body);
  // The conversation is a nicety: the issue still opens when its timeline can't be read.
  const timeline = await reads
    .read({ op: "forge.issue.timeline", ...scope, page: 1 }, false)
    .catch(() => undefined);
  const events = timeline?.resource === "issueTimeline" ? timeline : undefined;
  const live = reads.linked().issues.get(keyOf(issue));
  return {
    type: "forge.issue",
    number: issue.ref.number,
    repository: issue.ref.repository,
    title: preview(issue.title, 400),
    url: issue.url,
    state: issueStateMark(issue.state),
    author: preview(issue.author, 100),
    createdAt: epoch(issue.createdAt),
    updatedAt: epoch(issue.updatedAt),
    body: preview(issue.body, 32_768),
    bodyBlocks: repositoryBlocks(preview(issue.body, 32_768), issue.ref.repository),
    tasks: issue.permissions.edit,
    labels: issue.labels.slice(0, 20).map((name) => ({
      name: preview(name, 100),
      color: issue.labelColors?.[name] ?? null,
    })),
    assignees: issue.assignees.slice(0, 20).map((login) => preview(login, 100)),
    milestone: issue.milestone ? preview(issue.milestone, 200) : null,
    events: (events?.events ?? []).map((event) => ({
      id: event.id,
      comment: event.kind === "issue_comment",
      actor: preview(event.actor, 100),
      event: preview(event.event, 100),
      at: epoch(event.at),
      body: event.body ? preview(event.body, 8_192) : null,
      blocks: event.body ? repositoryBlocks(preview(event.body, 8_192), issue.ref.repository) : [],
    })),
    moreEvents: events?.nextPage !== undefined,
    threads: issue.relatedThreads.slice(0, 20).map((thread) => ({
      id: thread.id,
      title: preview(thread.title, 200),
      archived: thread.archived,
      needsYou: live?.id === thread.id && live.needsYou,
    })),
    start: { text: preview(issueSourceText(issue), 32_768), issue: issue.ref },
  };
}
