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
/** Words handed to a thread's composer (the PR panel's "Fix with agent"), never sent for you. */
const textReceivers = new Map<string, (text: string) => void>();
export function receiveComposerText(threadId: string, receive: (text: string) => void): () => void {
  textReceivers.set(threadId, receive);
  return () => {
    if (textReceivers.get(threadId) === receive) textReceivers.delete(threadId);
  };
}
/** Put `text` in the thread's composer at the caret; false when no composer is mounted. */
export function insertTextInComposer(threadId: string, text: string): boolean {
  const receive = textReceivers.get(threadId);
  if (!receive) return false;
  receive(text);
  return true;
}
/**
 * Put `text` in the thread's composer as soon as one mounts (the thread was just opened); false
 * when none mounts within `waitMs`.
 */
export function insertTextWhenMounted(
  threadId: string,
  text: string,
  waitMs = 3_000,
  pollMs = 100,
): Promise<boolean> {
  if (insertTextInComposer(threadId, text)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (insertTextInComposer(threadId, text)) {
        clearInterval(timer);
        resolve(true);
      } else if (performance.now() - started > waitMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, pollMs);
  });
}
/** Put a mention of `tab` in the thread's composer; false when no composer is mounted. */
export function mentionTabInComposer(threadId: string, tab: ComposerTab): boolean {
  const receive = tabReceivers.get(threadId);
  if (!receive) return false;
  receive(tab);
  return true;
}
