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
