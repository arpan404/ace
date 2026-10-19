import { ClientError } from "@ace/client";
import {
  maxCommitMessageLength,
  maxForgeTextLength,
  SourceControlPreferences,
  ThreadId,
  type CommandPayload,
  type CommandResult,
} from "@ace/protocol";
import {
  actionErrorText,
  changesNextStep,
  checkoutOf,
  mergeMethods,
  parseReviewers,
} from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { WorkspaceRefusal, type ChangesOwner, type ChangesSession } from "./changes.ts";
import { draftContext } from "./git-drafts.ts";

/*
 * The Changes sheet's next step through the daemon's guarded git and forge commands, the same
 * ones the web's git action sends: commit (with the HEAD `git.status` reported), push to the
 * person's configured remote, push then open a PR (asking for reviews), or merge the linked PR
 * at the head the person saw by the method they picked. A message or title the person took from
 * an AI draft carries that draft's fingerprint, so the daemon refuses it once the changes moved.
 * The daemon enforces the device's grant; a view-only phone never offers these.
 */

/** Reviewers as the person typed them ("ana, @bo"), checked by the shared rule before anything runs. */
const reviewerText = z.string().max(4096).default("");
/** Only a method the shared list offers; anything else is refused before the forge sees it. */
const method = z.string().transform((value, context) => {
  const offered = mergeMethods.find((each) => each.method === value);
  if (!offered) {
    context.addIssue({ code: "custom", message: "Not an offered merge method" });
    return z.NEVER;
  }
  return offered.method;
});

export const GitAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    message: z
      .string()
      .max(maxCommitMessageLength)
      .refine((value) => value.trim().length > 0),
    push: z.boolean(),
    /** The message came from the session's commit draft. */
    drafted: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("push") }),
  z.object({
    kind: z.literal("create-pr"),
    title: z.string().trim().min(1).max(256),
    summary: z.string().max(maxForgeTextLength).default(""),
    reviewers: reviewerText,
    /** The title and summary came from the session's PR draft. */
    drafted: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("merge"), method }),
  z.object({ kind: z.literal("request-review"), reviewers: reviewerText }),
]);
export type GitAction = z.infer<typeof GitAction>;

async function run(owner: ChangesOwner, payload: CommandPayload): Promise<CommandResult> {
  const result = await owner.command(payload);
  if (!result.ok) throw new WorkspaceRefusal(result.error ?? "failed");
  return result;
}

/** Push where the person's source-control preferences say, as the web does. */
async function push(
  owner: ChangesOwner,
  threadId: ThreadId,
  target?: Extract<CommandPayload, { type: "git.push" }>["target"],
): Promise<void> {
  const response = await owner.request({
    type: "settings.get",
    key: "sourceControl.preferences",
    scope: {},
  });
  const entry = response.entries.find((item) => item.key === "sourceControl.preferences");
  if (!response.ok || !entry) throw new WorkspaceRefusal("forge_preferences_changed");
  const preferences = SourceControlPreferences.parse(entry.value);
  await run(owner, {
    type: "git.push",
    threadId,
    remote: preferences.remote,
    ...(target ? { target } : {}),
  });
}

async function perform(owner: ChangesOwner, session: ChangesSession, action: GitAction) {
  const threadId = ThreadId.parse(session.threadId);
  const details = session.details;
  const reads = session.reads;
  const totals = reads && {
    files: reads.files.length,
    additions: reads.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: reads.files.reduce((sum, file) => sum + file.deletions, 0),
  };
  // The step the sheet offered must still be the step, and not blocked, when it runs. A review
  // request rides on the open PR's step, which the merge gate doesn't block.
  const step = changesNextStep(details, reads?.pr, totals);
  const expected = action.kind === "request-review" ? "merge" : action.kind;
  if (action.kind !== "push" && step.kind !== expected)
    throw new WorkspaceRefusal("pr_link_changed");
  if (step.blocked && step.kind === expected && action.kind !== "request-review")
    throw new Error(step.blocked);
  if (action.kind === "commit") {
    const draft = action.drafted ? takeDraft(session, "commit") : undefined;
    await run(owner, {
      type: "git.commit",
      threadId,
      message: action.message,
      // The HEAD `git.status` read with these files: a commit made meanwhile is refused.
      expectedHead: reads?.head !== undefined ? reads.head : (details?.head ?? null),
      // A drafted message commits exactly the files it was written about.
      ...(draft?.selection.kind === "commit"
        ? { paths: [...draft.selection.paths], draftFingerprint: draft.fingerprint }
        : {}),
    });
    if (draft) session.draft = undefined;
    if (!action.push) return "Committed";
    try {
      await push(owner, threadId);
    } catch (error) {
      return { partial: `Committed. The push didn't go through: ${message(error)}` };
    }
    return "Committed and pushed";
  }
  if (action.kind === "push") {
    await push(owner, threadId);
    return "Pushed";
  }
  const checkout = checkoutOf(details, reads?.pr);
  if (action.kind === "create-pr") {
    if (!checkout?.branch) throw new WorkspaceRefusal("pr_unavailable");
    if (!checkout.repository) throw new WorkspaceRefusal("forge_no_remote");
    const reviewers = reviewersOf(action.reviewers);
    const draft = action.drafted ? takeDraft(session, "create-pr") : undefined;
    // As the web does: a drafted summary is checked against the branch before anything moves.
    if (draft) {
      const now = await draftContext(owner, session.threadId, draft.selection);
      if (now.fingerprint !== draft.fingerprint) throw new WorkspaceRefusal("draft_changes_moved");
    }
    // A branch without an upstream reports nothing ahead; pushing first is always safe.
    await push(owner, threadId, {
      repository: checkout.repository,
      branch: checkout.branch,
      head: checkout.head,
    });
    const selection = draft?.selection.kind === "pr" ? draft.selection : undefined;
    const created = await run(owner, {
      type: "forge.pr.create",
      threadId: session.threadId,
      repository: checkout.repository,
      // Only a reviewed draft names its base; otherwise the daemon resolves it.
      ...(draft && selection
        ? {
            draftFingerprint: draft.fingerprint,
            ...(selection.baseRef ? { draftBaseRef: selection.baseRef } : {}),
          }
        : {}),
      input: {
        branch: checkout.branch,
        ...(selection ? { base: selection.base } : {}),
        title: action.title,
        summary: action.summary.trim(),
        template: { title: "{{title}}", body: "{{summary}}" },
        draft: false,
        ...(checkout.head ? { expectedHead: checkout.head } : {}),
      },
    });
    if (draft) session.draft = undefined;
    const ref = created.prStatus?.ref ?? created.pr;
    if (!reviewers.length || !ref) return "Pull request opened";
    try {
      await requestReview(owner, session.threadId, ref, reviewers);
    } catch (error) {
      // The PR is open either way: say what happened, not that opening it failed.
      return {
        partial: `Pull request opened. The review request didn't go through: ${message(error)}`,
      };
    }
    return "Pull request opened and review requested";
  }
  const pr = reads?.pr;
  if (!pr) throw new WorkspaceRefusal("pr_not_linked");
  if (action.kind === "request-review") {
    const reviewers = reviewersOf(action.reviewers);
    if (!reviewers.length) throw new Error("Name at least one reviewer.");
    await requestReview(owner, session.threadId, pr.ref, reviewers);
    return "Review requested";
  }
  await run(owner, {
    type: "forge.pr.merge",
    link: { threadId: session.threadId, pr: pr.ref },
    headSha: pr.headSha,
    method: action.method,
  });
  return "Merged";
}

/** The session's draft for this step, or a refusal: the person's draft is gone or for another step. */
function takeDraft(session: ChangesSession, kind: "commit" | "create-pr") {
  const draft = session.draft;
  if (!draft || draft.for !== kind) throw new WorkspaceRefusal("draft_changes_moved");
  return draft;
}

function reviewersOf(text: string): string[] {
  const parsed = parseReviewers(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.reviewers;
}

async function requestReview(
  owner: ChangesOwner,
  threadId: string,
  pr: Extract<CommandPayload, { type: "forge.review.request" }>["link"]["pr"],
  reviewers: string[],
): Promise<void> {
  await run(owner, { type: "forge.review.request", link: { threadId, pr }, reviewers });
}

function message(error: unknown): string {
  if (error instanceof WorkspaceRefusal) return actionErrorText(error.code);
  if (error instanceof ClientError) return actionErrorText(error.code);
  if (error instanceof Error && error.message) return error.message;
  return actionErrorText(undefined);
}

/** One git step at a time per sheet; the outcome arrives as `git.result` with the request id. */
export async function gitAction(
  owner: ChangesOwner,
  session: ChangesSession,
  raw: unknown,
  requestId: string,
  sink: PatchSink,
  preview: Preview,
): Promise<void> {
  const result = (ok: boolean, text: string) =>
    sink.put(`git:${requestId}`, () => ({
      type: "git.result",
      id: requestId,
      ok,
      message: preview(text, 2048),
    }));
  const parsed = GitAction.safeParse(raw);
  if (!parsed.success) return result(false, "Could not read that git action.");
  if (session.busy) return result(false, "Another git action is still running.");
  session.busy = true;
  session.summary();
  try {
    const outcome = await perform(owner, session, parsed.data);
    if (typeof outcome === "string") result(true, outcome);
    else result(false, outcome.partial);
  } catch (error) {
    result(false, message(error));
  } finally {
    session.busy = false;
    // Move to the next step from what the daemon reports, never from a guess.
    await session.refresh();
  }
}
