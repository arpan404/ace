import type { ThreadReader } from "@ace/client";
import type { CommandPayload, FollowUpBehavior, Interaction, ThreadId } from "@ace/protocol";
import { followUpDelivery, isBusy, modelLabel, stopFence } from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";
import { preview } from "./presentation.ts";

/*
 * The composer's decisions, made here over the SDK reader so Swift never derives them: how a
 * message sent now is delivered (the web's shared steer/queue rule), what Stop targets, and which
 * answers a question accepts. Pure over the reader and the person's input.
 */

const questionPending = (reader: ThreadReader) =>
  reader.interactionIds().some((id) => {
    const interaction = reader.interaction(id);
    return interaction?.state === "pending" && interaction.request.kind === "question";
  });

export function controlsRow(reader: ThreadReader, setting: FollowUpBehavior | undefined) {
  const thread = reader.thread;
  const status = thread?.status;
  const canSteer = thread?.capabilities?.steer === true;
  const input = { status, canSteer, setting };
  const delivery = followUpDelivery({ ...input, opposite: false });
  const alternate = followUpDelivery({ ...input, opposite: true });
  const selection = runsOn(thread);
  const busy = isBusy(status);
  return {
    busy,
    delivery: delivery ?? null,
    alternate: alternate === delivery ? null : (alternate ?? null),
    // Stop is hidden while the agent asks a question: answering is how that turn moves on.
    canStop: busy && !questionPending(reader) && stopFence(reader) !== undefined,
    provider: selection?.provider ?? thread?.provider ?? "",
    model: preview(selection?.model ? modelLabel(selection.model) : "", 128),
    switching: thread?.switch?.state ?? "",
  };
}

/** A message for this thread, delivered as the composer showed it would be. */
export function sendPayload(
  reader: ThreadReader,
  threadId: ThreadId,
  text: string,
  options: { opposite: boolean; setting: FollowUpBehavior | undefined },
): CommandPayload {
  const delivery = followUpDelivery({
    status: reader.thread?.status,
    canSteer: reader.thread?.capabilities?.steer === true,
    setting: options.setting,
    opposite: options.opposite,
  });
  return {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text }],
    ...(delivery ? { delivery } : {}),
  };
}

/** Stop the whole tree of the turn the person saw; undefined when no turn can be named. */
export function stopPayload(reader: ThreadReader, threadId: ThreadId): CommandPayload | undefined {
  const fence = stopFence(reader);
  return fence && { type: "thread.interrupt", threadId, cascade: true, ...fence };
}

/**
 * The canonical resolution for a question, or undefined when the answers don't fit what was
 * asked: every value an offered option id or, where the question allows it, the person's own
 * words; one value unless it is multiple choice. Skipping sends no answers.
 */
export function answerResolution(
  interaction: Interaction | undefined,
  answers: Readonly<Record<string, readonly string[]>>,
  dismissed: boolean,
): Extract<CommandPayload, { type: "interaction.resolve" }>["resolution"] | undefined {
  if (interaction?.state !== "pending" || interaction.request.kind !== "question") return undefined;
  if (dismissed) return { kind: "question", answers: {}, dismissed: true };
  const resolved: Record<string, string[]> = {};
  for (const question of interaction.request.questions) {
    const offered = new Set(question.options.map((option) => option.id));
    const values = (answers[question.id] ?? []).map((value) =>
      offered.has(value) ? value : value.trim(),
    );
    if (!values.length || values.some((value) => !value)) return undefined;
    if (values.length > 1 && !question.multiSelect) return undefined;
    if (values.some((value) => !offered.has(value) && !question.allowOther)) return undefined;
    resolved[question.id] = values;
  }
  for (const id of Object.keys(answers)) if (!(id in resolved)) return undefined;
  return { kind: "question", answers: resolved };
}
