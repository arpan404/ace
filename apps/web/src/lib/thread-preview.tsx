import { createContext, use, type ComponentType, type ReactElement } from "react";

/**
 * A thread's details on hover, wherever a thread is named (a delegated agent in a transcript, a
 * thread an agent started), the same card the Threads panel's rows open. The card is Home's; the
 * app supplies it here (`ThreadPreviewProvider`), so a feature that names a thread can offer it
 * without importing Home. With none supplied, the trigger shows alone.
 */
export type ThreadPreviewView = ComponentType<{ threadId: string; children: ReactElement }>;

const PreviewView = createContext<ThreadPreviewView | undefined>(undefined);
export const ThreadPreviewProvider = PreviewView;

/** `children` (one element: the row's link), opening `threadId`'s details card on hover. */
export function ThreadPreview(props: { threadId: string; children: ReactElement }) {
  const View = use(PreviewView);
  return View ? <View threadId={props.threadId}>{props.children}</View> : props.children;
}
