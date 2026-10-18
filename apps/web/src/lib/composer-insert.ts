import type { Mention } from "@ace/protocol";
/** File viewers hand references to the mounted composer in the same thread. */
const receivers = new Map<string, (mention: Mention) => void>();
export function receiveComposerMentions(
  threadId: string,
  receive: (mention: Mention) => void,
): () => void {
  receivers.set(threadId, receive);
  return () => {
    if (receivers.get(threadId) === receive) receivers.delete(threadId);
  };
}
export function mentionInComposer(threadId: string, mention: Mention): boolean {
  const receive = receivers.get(threadId);
  if (!receive) return false;
  receive(mention);
  return true;
}

/** A browser tab handed to the thread's composer as an `@` mention. */
export interface ComposerTab {
  tabId: string;
  url: string;
  title: string;
}
const tabReceivers = new Map<string, (tab: ComposerTab) => void>();
export function receiveComposerTabs(
  threadId: string,
  receive: (tab: ComposerTab) => void,
): () => void {
  tabReceivers.set(threadId, receive);
  return () => {
    if (tabReceivers.get(threadId) === receive) tabReceivers.delete(threadId);
  };
}
/** Put a mention of `tab` in the thread's composer; false when no composer is mounted. */
export function mentionTabInComposer(threadId: string, tab: ComposerTab): boolean {
  const receive = tabReceivers.get(threadId);
  if (!receive) return false;
  receive(tab);
  return true;
}
