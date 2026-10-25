import {
  ForgeHostedLifecycleCommand,
  ForgeRepository,
  WorkspaceId,
  type CommandPayload,
} from "@ace/protocol";
import { actionErrorText, authoredReviewComment } from "@ace/ui-core";
import { withTask } from "@ace/ui-core/forge-rich";
import { z } from "zod";
import { shownKey, type ShownBodies } from "./forge-conversation.ts";
import { prLifecycle, scopeOf } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";
import { writeReview } from "./forge-review-write.ts";

/*
 * A task box ticked on the phone, saved as the web saves it: only that box's mark changes, in
 * the text as the phone showed it, through the guarded edit of what holds it (a comment, a pull
 * request's description, an issue's body). Text changed elsewhere since is never overwritten;
 * the person reads it again first. Sent once; a lost answer is said to be unconfirmed.
 */

export const ForgeTaskRequest = z.object({
  type: z.literal("forge.task"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository,
  on: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("comment"),
      source: z.enum(["issue", "inline"]),
      commentId: z.number().int().positive(),
    }),
    z.object({ kind: z.literal("pull") }),
    z.object({ kind: z.literal("issue") }),
  ]),
  offset: z.number().int().nonnegative(),
  checked: z.boolean(),
});
export type ForgeTaskRequest = z.infer<typeof ForgeTaskRequest>;

/** Where a pull request's or issue's own body is remembered as shown. */
export const bodyKey = (kind: "pull" | "issue", repository: ForgeRepository, number: number) =>
  `${kind}:${repository.host}/${repository.owner}/${repository.name}#${number}`;

const changed = "This text changed on GitHub. Refresh to see it first.";
const lost = "Couldn't confirm the change. Refresh to see whether it was saved.";
type Reply = { type: "forge.write"; ok: boolean; message: string; uncertain: boolean };
const refuse = (message: string): Reply => ({
  type: "forge.write",
  ok: false,
  message,
  uncertain: false,
});

/** The text with the box at `offset` set, or why it can't be. */
function ticked(shown: string | undefined, request: ForgeTaskRequest): string | Reply {
  if (shown === undefined) return refuse(changed);
  return withTask(shown, { offset: request.offset, label: "" }, request.checked) ?? refuse(changed);
}

async function send(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeTaskRequest,
  payload: CommandPayload,
) {
  try {
    const result = await owner.command(payload);
    reads.forget(request.project);
    if (result.ok)
      return { type: "forge.write", ok: true, message: "", uncertain: false } satisfies Reply;
    if (result.error === "action_outcome_uncertain" || result.issueAction?.state === "uncertain")
      return { type: "forge.write", ok: false, message: lost, uncertain: true } satisfies Reply;
    return refuse(actionErrorText(result.error));
  } catch {
    reads.forget(request.project);
    return { type: "forge.write", ok: false, message: lost, uncertain: true } satisfies Reply;
  }
}

export async function writeTask(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeTaskRequest,
  shown: ShownBodies,
): Promise<Reply> {
  const on = request.on;
  if (on.kind === "comment") {
    const next = ticked(shown.get(shownKey(on.source, on.commentId)), request);
    if (typeof next !== "string") return next;
    return await writeReview(
      owner,
      reads,
      {
        type: "forge.review",
        project: request.project,
        number: request.number,
        repository: request.repository,
        action: {
          kind: "comment.edit",
          source: on.source,
          commentId: on.commentId,
          body: authoredReviewComment(next),
        },
      },
      shown,
      () => "",
    );
  }
  const seen = shown.get(bodyKey(on.kind, request.repository, request.number));
  const next = ticked(seen, request);
  if (typeof next !== "string") return next;
  if (on.kind === "pull") {
    // The description is edited at the version GitHub has now, only if it still reads as shown.
    const lifecycle = await prLifecycle(reads, request);
    if (!lifecycle) return refuse(actionErrorText("forge_unavailable"));
    if (lifecycle.snapshot.metadata.body !== seen) return refuse(changed);
    if (!lifecycle.snapshot.editableFields.includes("body"))
      return refuse("GitHub doesn't let this account edit the description.");
    return await send(
      owner,
      reads,
      request,
      ForgeHostedLifecycleCommand.parse({
        type: "forge.hosted.lifecycle",
        workspaceId: request.project,
        pr: { repository: request.repository, number: request.number },
        operation: {
          kind: "apply",
          expectedVersion: lifecycle.snapshot.version,
          action: { kind: "edit", changes: { body: next } },
        },
      }),
    );
  }
  const value = await reads.read({ op: "forge.issue.detail", ...scopeOf(request) }, false);
  if (value.resource !== "issueDetail") throw new ForgeRefusal("forge_invalid_data");
  const issue = value.value;
  if (issue.body !== seen) return refuse(changed);
  if (!issue.permissions.edit)
    return refuse(issue.permissions.reason || "GitHub doesn't let this account edit it.");
  return await send(owner, reads, request, {
    type: "forge.issue.write",
    workspaceId: WorkspaceId.parse(request.project),
    repository: request.repository,
    input: {
      action: "edit",
      number: request.number,
      expectedUpdatedAt: issue.updatedAt,
      title: issue.title,
      body: next,
    },
  });
}
