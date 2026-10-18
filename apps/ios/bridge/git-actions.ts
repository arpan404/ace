import { ClientError } from "@ace/client";
import {
  maxCommitMessageLength,
  SourceControlPreferences,
  ThreadId,
  type CommandPayload,
  type CommandResult,
} from "@ace/protocol";
import { actionErrorText, changesNextStep, checkoutOf, mergeMethods } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { WorkspaceRefusal, type ChangesOwner, type ChangesSession } from "./changes.ts";

/*
 * The Changes sheet's next step through the daemon's guarded git and forge commands, the same
 * ones the web's git action sends: commit (with the HEAD `git.status` reported), push to the
 * person's configured remote, push then open a PR, or merge the linked PR at the head the
 * person saw. The daemon enforces the device's grant; a view-only phone never offers these.
 */

export const GitAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    message: z
      .string()
      .max(maxCommitMessageLength)
      .refine((value) => value.trim().length > 0),
    push: z.boolean(),
  }),
  z.object({ kind: z.literal("push") }),
  z.object({ kind: z.literal("create-pr"), title: z.string().trim().min(1).max(256) }),
  z.object({ kind: z.literal("merge") }),
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
  // The step the sheet offered must still be the step, and not blocked, when it runs.
  const step = changesNextStep(details, reads?.pr, totals);
  const expected = action.kind;
  if (action.kind !== "push" && step.kind !== expected)
    throw new WorkspaceRefusal("pr_link_changed");
  if (step.blocked && step.kind === expected) throw new Error(step.blocked);
  if (action.kind === "commit") {
    await run(owner, {
      type: "git.commit",
      threadId,
      message: action.message,
      // The HEAD `git.status` read with these files: a commit made meanwhile is refused.
      expectedHead: reads?.head !== undefined ? reads.head : (details?.head ?? null),
    });
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
    // A branch without an upstream reports nothing ahead; pushing first is always safe.
    await push(owner, threadId, {
      repository: checkout.repository,
      branch: checkout.branch,
      head: checkout.head,
    });
    await run(owner, {
      type: "forge.pr.create",
      threadId: session.threadId,
      repository: checkout.repository,
      input: {
        branch: checkout.branch,
        title: action.title,
        summary: "",
        template: { title: "{{title}}", body: "{{summary}}" },
        draft: false,
        ...(checkout.head ? { expectedHead: checkout.head } : {}),
      },
    });
    return "Pull request opened";
  }
  const pr = reads?.pr;
  if (!pr) throw new WorkspaceRefusal("pr_not_linked");
  await run(owner, {
    type: "forge.pr.merge",
    link: { threadId: session.threadId, pr: pr.ref },
    headSha: pr.headSha,
    method: mergeMethods[0]?.method ?? "squash",
  });
  return "Merged";
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
