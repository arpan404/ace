import type { ThreadReader } from "@ace/client";
import { maxMessageBytes, type ForkPoint, type ProviderKind } from "@ace/protocol";
import { accountDisplayName } from "./accounts.ts";
import { imagesUnreadable } from "./attachment-fit.ts";
import { imageType } from "./checkout-files.ts";
import { latestFinishedTurn } from "./fork-point.ts";
import type { ModelChoice } from "./models.ts";
import { providerNames } from "./providers.ts";
import { activeRootRun } from "./stop-fence.ts";

/*
 * A thread continued in another one: the person picked a model this thread can't move to in place
 * (the switch route `new_thread`), or asked for it, and their next message starts a fork on it
 * from this thread's newest finished turn, carrying its context. Pure rules and words, shared by
 * every client so each refuses and asks the same way.
 */

/** How much of the source thread a fork's opening handoff carries, in bytes. */
export const forkBudgetBytes = 16384;

/** Why the main agent's running turn holds a continuation back; the composer offers Stop. */
export const turnStillRunningMessage =
  "The agent is still on this turn. Stop it, then send again to continue in a new thread.";

/** The first message of a fork as it goes, or why it can't. */
export function forkInput(text: string): { input: string } | { refused: string } {
  const input = text.trim();
  if (!input) return { refused: "Write a message to start the new thread." };
  if (input.length > maxMessageBytes)
    return { refused: "The message is too long to start a new thread with." };
  return { input };
}

export type ContinuationPlan =
  | { ok: true; point: ForkPoint; input: string }
  /** `running`: only the main agent's own turn holds it back, so stopping it lets it go. */
  | { ok: false; running: boolean; message: string };

/**
 * Where the person's message continues `reader`'s thread: its newest finished turn, whatever
 * its outcome. Only the main agent's own running turn holds it back; a usage limit, background
 * commands and subagents stay with this thread.
 */
export function continuationPlan(reader: ThreadReader, text: string): ContinuationPlan {
  if (activeRootRun(reader) !== undefined)
    return { ok: false, running: true, message: turnStillRunningMessage };
  const point = latestFinishedTurn(reader, reader.thread?.rootAgentId);
  if (!point)
    return {
      ok: false,
      running: false,
      message: "This thread has no finished turn to carry over. Start a new thread instead.",
    };
  const input = forkInput(text);
  return "refused" in input
    ? { ok: false, running: false, message: input.refused }
    : { ok: true, point, input: input.input };
}

/**
 * Why the new thread's model can't take one of these files, or undefined when it can take them
 * all. Only images can be refused: the model's catalog entry says which inputs it reads. Any
 * other file reaches every provider (inline, as a document or as a path), as a send's does.
 */
export function continuationAttachmentProblem(
  files: readonly { name: string; mimeType?: string | undefined }[],
  choice: Pick<ModelChoice, "provider" | "model">,
  modalities: readonly string[] | undefined,
): string | undefined {
  const images = files.filter((file) =>
    (file.mimeType ?? imageType(file.name) ?? "").startsWith("image/"),
  );
  if (!images.length) return undefined;
  const unreadable = imagesUnreadable({
    provider: providerNames[choice.provider],
    imageInput: undefined,
    model: choice.model,
    modalities,
  });
  return unreadable && `${unreadable} Remove ${images.map((file) => file.name).join(", ")} first.`;
}

/** What the person confirms before a thread moves to another provider or continues elsewhere. */
export interface SwitchQuestion {
  title: string;
  message: string;
  /** "Model: Sonnet 4.5", for a switch in place. */
  detail: string | undefined;
  /** Something in the message being written that can't go to the new thread, and what to do. */
  warning: string | undefined;
  /** The confirming button: "Switch to Claude Code", "Continue on Claude Code". */
  action: string;
}

/**
 * The question asked before moving a thread from `from` to `to`. The new agent reads a summary
 * of the thread, not the old one's private working state, and a switch waits for the running
 * turn to finish. `continues`: the thread can't move in place, so the next message starts a new
 * thread with this one's context instead.
 */
export function switchQuestion(input: {
  from: ProviderKind;
  to: Pick<ModelChoice, "provider" | "model" | "account">;
  busy: boolean;
  continues: boolean;
  warning?: string | undefined;
}): SwitchQuestion {
  const to = providerNames[input.to.provider];
  const from = providerNames[input.from];
  const target = input.to.account
    ? `${input.to.model} on ${accountDisplayName(input.to.account)}`
    : input.to.model;
  if (input.continues)
    return {
      title: "Continue in a new thread?",
      message: `Your next message starts a new thread on ${target}, with this conversation as its context. Its files go with it. This thread stays as it is.`,
      detail: undefined,
      warning: input.warning,
      action: `Continue on ${to}`,
    };
  return {
    title: `Switch to ${to}?`,
    message:
      `${to} picks up from a summary of this thread. What ${from} kept to itself (its scratch state and tool sessions) doesn't carry over.` +
      (input.busy ? " The switch happens once the current turn finishes." : ""),
    detail: `Model: ${input.to.model}`,
    warning: undefined,
    action: `Switch to ${to}`,
  };
}
