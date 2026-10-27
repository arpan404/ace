import { ClientError } from "@ace/client";
import {
  SourceControlPreferences,
  ThreadId,
  type CommandPayload,
  type CommandResult,
  type ForgeRepository,
} from "@ace/protocol";
import {
  actionErrorText,
  checkoutOf,
  dirtyMoveQuestion,
  parsePrReference,
  staleLockOutcome,
  type CheckoutMove,
} from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import type { ChangesOwner } from "./changes.ts";
import { findProblemAction, type WorkSubject } from "./work.ts";

/*
 * The Work sheet's writes, through the same daemon commands the web's Work card sends: switch
 * branch or move between the local checkout and a worktree (`thread.workspace.set`), recover a
 * failed move or setup, link and unlink pull requests, and clear a stale Git lock. Each is sent
 * once; its outcome arrives as `work.result` with the request id. A refusal says why; an answer
 * that never came is reported as unconfirmed, never as done. A move that met uncommitted changes
 * comes back with the shared question, and runs again only once the person says so.
 */

const Repository = z.object({ owner: z.string().max(512), name: z.string().max(100) });

export const WorkAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("switch"),
    branch: z.string().min(1).max(1024),
    allowUncommitted: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("move"),
    mode: z.enum(["local", "worktree"]),
    allowUncommitted: z.boolean().default(false),
  }),
  /** One of the current checkout problem's ways out, by the id the summary sent. */
  z.object({
    kind: z.literal("problem"),
    id: z.string().min(1).max(64),
    allowUncommitted: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("link"), reference: z.string().trim().min(1).max(2000) }),
  z.object({
    kind: z.literal("unlink"),
    number: z.number().int().positive(),
    repo: Repository,
  }),
]);
export type WorkAction = z.infer<typeof WorkAction>;

interface Outcome {
  ok: boolean;
  message: string;
  /** Sent, but the daemon's answer never came: it may have gone through. */
  uncertain?: boolean;
  /** Uncommitted changes stopped a move: the question to ask before sending it again. */
  ask?: { title: string; detail: string; confirm: string };
}

/** A refusal in the shared words; `detail` is the daemon's own explanation, when it gave one. */
class Refused extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ?? actionErrorText(code));
    this.code = code;
  }
}

const unconfirmed: Outcome = {
  ok: false,
  uncertain: true,
  message:
    "ace didn't confirm it. It may have gone through: check the checkout before trying again.",
};

async function run(owner: ChangesOwner, payload: CommandPayload): Promise<CommandResult> {
  const result = await owner.command(payload);
  if (!result.ok) throw new Refused(result.error ?? "failed", result.detail);
  return result;
}

/** What went wrong, sorted into refused (with why), not sent, and unconfirmed. */
function failed(error: unknown): Outcome {
  if (error instanceof Refused) return { ok: false, message: error.message };
  if (error instanceof ClientError) {
    if (error.code === "offline" || error.code === "not_dispatched")
      return {
        ok: false,
        message: "Not sent: the machine isn't connected. Try again once it is.",
      };
    return unconfirmed;
  }
  if (error instanceof Error && error.message) return { ok: false, message: error.message };
  return { ok: false, message: actionErrorText(undefined) };
}

/** Moves the checkout; uncommitted changes come back as the question, not a failure. */
async function move(
  session: WorkSubject,
  change: CheckoutMove,
  allowUncommitted: boolean,
  done: string,
): Promise<Outcome> {
  try {
    await run(session.owner, {
      type: "thread.workspace.set",
      threadId: ThreadId.parse(session.threadId),
      mode: change.mode,
      ...(change.branch ? { branch: change.branch } : {}),
      allowUncommitted,
    });
    return { ok: true, message: done };
  } catch (error) {
    if (error instanceof Refused && error.code === "git_dirty_worktree" && !allowUncommitted)
      return { ok: false, message: "", ask: dirtyMoveQuestion(change.branch) };
    return failed(error);
  }
}

/** The person's PR reference against this machine's allowed hosts, as the web reads it. */
async function reference(
  owner: ChangesOwner,
  text: string,
  repository: ForgeRepository | undefined,
): Promise<{ number: number; repository: ForgeRepository }> {
  const response = await owner.request({
    type: "settings.get",
    key: "sourceControl.preferences",
    scope: {},
  });
  const entry = response.entries.find((item) => item.key === "sourceControl.preferences");
  if (!response.ok || !entry)
    throw new Error(
      "Couldn't read this computer's source control settings. Reconnect and try again.",
    );
  const hosts = SourceControlPreferences.parse(entry.value).hosts.map((item) => item.host);
  const parsed = parsePrReference(text, repository, hosts);
  if ("error" in parsed) throw new Error(parsed.error);
  const target = parsed.repository ?? repository;
  if (!target) throw new Refused("forge_no_remote");
  return { number: parsed.number, repository: target };
}

async function perform(session: WorkSubject, action: WorkAction): Promise<Outcome> {
  const details = session.details;
  const checkout = checkoutOf(details);
  const reasons = session.reasons;
  switch (action.kind) {
    case "switch":
      // The sheet offered it; the rules must still allow it when it runs.
      if (reasons.switchReason) return { ok: false, message: reasons.switchReason };
      if (action.branch === checkout?.branch)
        return { ok: false, message: `The checkout is already on ${action.branch}.` };
      return move(
        session,
        { mode: checkout?.mode ?? "local", branch: action.branch },
        action.allowUncommitted,
        `Switched to ${action.branch}`,
      );
    case "move": {
      const reason = action.mode === "worktree" ? reasons.worktreeReason : reasons.switchReason;
      if (reason) return { ok: false, message: reason };
      if (checkout?.mode === action.mode)
        return { ok: false, message: "The checkout is already there." };
      return move(
        session,
        { mode: action.mode },
        action.allowUncommitted,
        action.mode === "worktree" ? "Moved to a worktree" : "Moved to the local checkout",
      );
    }
    case "problem": {
      const found = findProblemAction(details, action.id);
      if (!found) return { ok: false, message: "That problem is already resolved." };
      if (found.kind === "retry-move")
        return move(session, found.move, action.allowUncommitted, "Checkout moved");
      if (found.kind === "move")
        return move(session, found.move, action.allowUncommitted, "Checkout moved");
      const threadId = ThreadId.parse(session.threadId);
      try {
        if (found.kind === "clear-move") {
          await run(session.owner, { type: "thread.workspace.clear", threadId });
          return { ok: true, message: "Move cleared" };
        }
        await run(session.owner, {
          type: "thread.workspace.setup",
          threadId,
          action: found.action,
        });
        // Either way the held first message goes now, as the web lets it.
        const { queue } = await session.owner.request({ type: "queue.get", threadId, limit: 1 });
        await run(session.owner, {
          type: "queue.resume",
          threadId,
          expectedRevision: queue.revision,
        });
        return {
          ok: true,
          message: found.action === "retry" ? "Setup is running again" : "Started without setup",
        };
      } catch (error) {
        return failed(error);
      }
    }
    case "link":
      try {
        const pr = await reference(session.owner, action.reference, checkout?.repository);
        await run(session.owner, {
          type: "forge.pr.link",
          link: { threadId: session.threadId, pr },
        });
        return { ok: true, message: `Linked #${pr.number}` };
      } catch (error) {
        return failed(error);
      }
    case "unlink": {
      const linked = details?.linkedPrs?.find(
        (pr) =>
          pr.number === action.number &&
          pr.repo.owner === action.repo.owner &&
          pr.repo.name === action.repo.name,
      );
      if (!linked) return { ok: false, message: `#${action.number} is no longer linked.` };
      try {
        await run(session.owner, {
          type: "forge.pr.unlink",
          threadId: session.threadId,
          number: linked.number,
          repo: linked.repo,
        });
        return { ok: true, message: `Unlinked #${linked.number}` };
      } catch (error) {
        return failed(error);
      }
    }
  }
}

function putResult(sink: PatchSink, preview: Preview, requestId: string, outcome: Outcome) {
  sink.put(`work:result:${requestId}`, () => ({
    type: "work.result",
    id: requestId,
    ok: outcome.ok,
    message: preview(outcome.message, 2048),
    uncertain: outcome.uncertain ?? false,
    ask: outcome.ask ?? null,
  }));
}

/** One Work write at a time per sheet. */
export async function workAction(
  session: WorkSubject,
  raw: unknown,
  requestId: string,
  sink: PatchSink,
  preview: Preview,
): Promise<void> {
  const parsed = WorkAction.safeParse(raw);
  if (!parsed.success)
    return putResult(sink, preview, requestId, {
      ok: false,
      message: "Could not read that action.",
    });
  if (session.busy)
    return putResult(sink, preview, requestId, {
      ok: false,
      message: "Another change to the checkout is still running.",
    });
  session.busy = true;
  session.summary();
  try {
    putResult(sink, preview, requestId, await perform(session, parsed.data));
  } finally {
    session.busy = false;
    session.summary();
  }
}

/**
 * "Clear stale lock" for the open thread, from the transcript or the Work sheet, once the person
 * confirmed. The daemon retires the lock only after checking its daemon has stopped; the words
 * say whether this cleared one, found none, or what still holds it.
 */
export async function clearStaleLock(
  owner: ChangesOwner,
  threadId: string,
  requestId: string,
  sink: PatchSink,
  preview: Preview,
): Promise<void> {
  let outcome: Outcome;
  try {
    const result = await owner.command({
      type: "git.lock.clear",
      threadId: ThreadId.parse(threadId),
    });
    const said = staleLockOutcome(result, { threadId });
    outcome = { ok: said.ok, message: `${said.title}. ${said.detail}` };
  } catch (error) {
    outcome = failed(error);
  }
  putResult(sink, preview, requestId, outcome);
}
