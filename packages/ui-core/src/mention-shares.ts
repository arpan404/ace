/*
 * What goes with a message the person sends to Spade bots or clubs from a thread (ADR 0194),
 * in words: the composer's "Shares: …" line before it is sent, ace's line after, and the daemon's
 * context pack all follow this one rule, so what the person reads is what went.
 */

/** How many of the thread's last turns go with it: a person's message and the agent's answer. */
export const sharedTurns = 3;

export interface ShareFacts {
  /** The project's name; none for a chat (ADR 0099). */
  project?: string | undefined;
  branch?: string | undefined;
  pullRequest?: number | undefined;
  /** Files the message mentions. */
  files: number;
}

/** The parts of the context pack, in words, in the order they go. */
export function sharesWords(facts: ShareFacts, share: "thread" | "message"): string[] {
  if (share === "message") return ["this message"];
  return [
    "this message",
    facts.project ? "the thread's title and project" : "the thread's title",
    ...(facts.branch ? [`branch ${facts.branch}`] : []),
    ...(facts.pullRequest ? [`PR #${facts.pullRequest}`] : []),
    `its last ${sharedTurns} turns`,
    ...(facts.files
      ? [facts.files === 1 ? "1 file it names" : `${facts.files} files it names`]
      : []),
  ];
}

/** "Shares: this message, the thread's title and project, its last 3 turns". */
export function sharesLine(words: readonly string[]): string {
  return `Shares: ${words.join(", ")}`;
}
