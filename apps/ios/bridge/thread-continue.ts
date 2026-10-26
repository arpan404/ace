import type { ThreadReader } from "@ace/client";
import {
  maxMessageBytes,
  type CommandPayload,
  type MessageContext,
  type ThreadId,
} from "@ace/protocol";
import { activeRootRun, choiceSelection, latestFinishedTurn, type ModelChoice } from "@ace/ui-core";

/*
 * A thread continued in a new one (the switch route `new_thread`): the person's next message is
 * the first of a fork from this thread's newest finished turn, on the model they picked, with
 * this thread's history as its context and the message's files. This thread stays as it is.
 * Only the main agent's own running turn holds it back, as on the web.
 */

export type Continuation = { payload: CommandPayload } | { refused: string };

export function continuationPayload(
  reader: ThreadReader,
  threadId: ThreadId,
  choice: ModelChoice,
  text: string,
  context: MessageContext | undefined,
): Continuation {
  const input = text.trim();
  if (!input) return { refused: "Write a message to start the new thread." };
  if (input.length > maxMessageBytes)
    return { refused: "The message is too long to start a new thread with." };
  if (activeRootRun(reader) !== undefined)
    return {
      refused:
        "The agent is still on this turn. Stop it, then send again to continue in a new thread.",
    };
  const point = latestFinishedTurn(reader, reader.thread?.rootAgentId);
  if (!point)
    return {
      refused: "This thread has no finished turn to carry over. Start a new thread instead.",
    };
  const title = reader.thread?.title;
  return {
    payload: {
      type: "thread.fork",
      threadId,
      point,
      input,
      budgetBytes: 16384,
      selection: { ...choiceSelection(choice), options: {} },
      ...(title ? { title } : {}),
      ...(context ? { context } : {}),
    },
  };
}
