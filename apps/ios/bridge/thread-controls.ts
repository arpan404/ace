import type { ThreadReader } from "@ace/client";
import type {
  CommandPayload,
  FollowUpBehavior,
  Interaction,
  ProviderKind,
  ThreadId,
} from "@ace/protocol";
import {
  followUpDelivery,
  isBusy,
  modelLabel,
  providerDisplayName,
  readTurnActivity,
  stopFence,
  waitingDelivery,
} from "@ace/ui-core";
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

/**
 * How a message sent now goes: the shared follow-up rule while the agent works, but while the
 * main agent only waits on its subagents the model itself isn't busy, so it goes in now (the
 * web's `waitingDelivery`).
 */
function deliveryOf(
  reader: ThreadReader,
  setting: FollowUpBehavior | undefined,
  opposite: boolean,
): FollowUpBehavior | undefined {
  const thread = reader.thread;
  const canSteer = thread?.capabilities?.steer === true;
  if (!isBusy(thread?.status)) return undefined;
  const rootId = thread?.rootAgentId ?? "";
  const wait = readTurnActivity(reader, rootId, { threadStatus: thread?.status }).activity
    ?.waitingOn;
  if (wait?.kind === "subagents")
    return waitingDelivery({ canSteer, turnOver: wait.turnOver, opposite });
  return followUpDelivery({ status: thread?.status, canSteer, setting, opposite });
}

/**
 * `next`: a model picked here that the daemon hasn't reported yet, or that the next message
 * continues on in a new thread; the model control names it, with its note.
 */
export function controlsRow(
  reader: ThreadReader,
  setting: FollowUpBehavior | undefined,
  next?: { provider: ProviderKind; model: string; note: string; continues: boolean },
) {
  const thread = reader.thread;
  const status = thread?.status;
  const delivery = deliveryOf(reader, setting, false);
  const alternate = deliveryOf(reader, setting, true);
  const selection = runsOn(thread);
  const busy = isBusy(status);
  const provider = next?.provider || selection?.provider || thread?.provider;
  const model = next?.model || (selection?.model ? modelLabel(selection.model) : "");
  return {
    busy,
    delivery: delivery ?? null,
    alternate: alternate === delivery ? null : (alternate ?? null),
    // Stop is hidden while the agent asks a question: answering is how that turn moves on.
    canStop: busy && !questionPending(reader) && stopFence(reader) !== undefined,
    provider: provider ?? "",
    /** "Claude": the model sheet's section header. */
    providerName: provider ? providerDisplayName(provider) : "",
    model: preview(model, 128),
    switching: thread?.switch?.state ?? "",
    /** Why the control names something the agent doesn't run on yet: "Applies at the agent's next turn". */
    note: next?.note ?? "",
    /** The next message starts a new thread on that model, carrying this one's context. */
    continues: next?.continues ?? false,
  };
}

/** A message for this thread, delivered as the composer showed it would be. */
export function sendPayload(
  reader: ThreadReader,
  threadId: ThreadId,
  text: string,
  options: { opposite: boolean; setting: FollowUpBehavior | undefined },
): CommandPayload {
  const delivery = deliveryOf(reader, options.setting, options.opposite);
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
