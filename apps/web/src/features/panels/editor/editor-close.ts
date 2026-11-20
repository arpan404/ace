import { askUnsaved } from "./unsaved-prompt.tsx";

/*
 * Closing the editor tab with unsaved files asks Save / Don't save / Cancel (spec 48), like closing
 * an editor. Loaded with the thread's kinds, so it stays small: the buffers answer through the
 * hooks the editor's registry installs once it exists (before that nothing can be unsaved).
 */

export interface EditorUnsaved {
  paths(threadId: string): string[];
  /** Save every unsaved file of the thread; true when all of them saved. */
  save(threadId: string): Promise<boolean>;
  discard(threadId: string): Promise<void>;
}

let unsaved: EditorUnsaved | undefined;
const closers = new Map<string, () => void>();

/** The registry's answers. */
export function provideUnsaved(next: EditorUnsaved): void {
  unsaved = next;
}

/** How a thread's screen closes its editor tab once the question is answered. */
export function onEditorClose(threadId: string, close: () => void): () => void {
  closers.set(threadId, close);
  return () => {
    if (closers.get(threadId) === close) closers.delete(threadId);
  };
}

/** The kind's `prepareClose`: true closes now; false asks first and closes after the answer. */
export function prepareEditorClose(threadId: string): boolean {
  const paths = unsaved?.paths(threadId) ?? [];
  if (paths.length === 0 || !unsaved) return true;
  const buffers = unsaved;
  void askUnsaved(paths).then(async (answer) => {
    if (answer === "cancel") return;
    if (answer === "save" && !(await buffers.save(threadId))) return;
    if (answer === "discard") await buffers.discard(threadId);
    closers.get(threadId)?.();
  });
  return false;
}
