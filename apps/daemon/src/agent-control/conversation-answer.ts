import { modelDisplayName } from "@ace/models/display-name";
import type { ProviderKind, Thread } from "@ace/protocol";

/** What `ace_thread_start` answers once the conversation exists. */
export interface ConversationAnswer {
  threadId: string;
  title: string;
  provider: ProviderKind;
  model?: string;
  /** The account's name as the person gave it ("Work"), when it has one. */
  account?: string;
  /** One sentence for the agent to relay; the person's client shows the thread as a card. */
  summary: string;
}

/**
 * The conversation an agent started, as the agent relays it. The person's client already shows
 * the started thread as a card with Open (from these fields) and lists it in the sidebar, so the
 * summary names it in words and tells the agent not to recite ids. Pure.
 */
export function conversationAnswer(
  thread: Thread,
  account: string | undefined,
): ConversationAnswer {
  const provider = thread.execution?.provider ?? thread.provider;
  const model = thread.execution?.model;
  const runsOn = [
    model ? modelDisplayName(model).displayName : undefined,
    account ? `the ${account} account` : undefined,
  ].filter(Boolean);
  return {
    threadId: thread.id,
    title: thread.title,
    provider,
    ...(model ? { model } : {}),
    ...(account ? { account } : {}),
    summary: `Started “${thread.title}”${runsOn.length ? ` with ${runsOn.join(" on ")}` : ""}. It is in the person's sidebar and shown in this thread as a card with Open; tell them it's ready in a sentence and don't repeat its id, provider or account id.`,
  };
}
