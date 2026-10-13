/*
 * What a failed request was, in the person's words: "Couldn't stop the agent", never a bare
 * "Action failed". The reason that follows it is the failure's own first line, kept short. Pure.
 */

const titles: Record<string, string> = {
  "thread.interrupt": "Couldn't stop the agent",
  "thread.resume": "Couldn't resume",
  "queue.resume": "Couldn't resume the queue",
  "thread.limit": "Couldn't resume after the limit",
  "thread.switch": "Couldn't switch the model",
  "thread.merge": "Couldn't merge the fork",
  "thread.fork": "Couldn't fork the thread",
  "thread.archive": "Couldn't archive the thread",
  "interaction.resolve": "Couldn't send your answer",
  "background_task.stop": "Couldn't stop the background task",
};

/** The failed request named by what the person asked for. */
export function failedActionTitle(kind: string): string {
  return titles[kind] ?? "Couldn't finish that";
}

/** The failure's first line, short enough to read inline beside the title. */
export function failureReason(message: string): string {
  const line =
    message
      .split("\n")
      .find((text) => text.trim())
      ?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
