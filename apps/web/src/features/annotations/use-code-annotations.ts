import type { CodeAnnotation } from "@ace/ui-core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { codeEditors, useComposerPort, type CodeEditorPort } from "./store.ts";

const none: readonly CodeAnnotation[] = [];
const quiet = () => () => {};

/** Whether an annotation was made on the side an editor shows: a diff's old side, or the file. */
export const onSide = (annotation: CodeAnnotation, side: "old" | "new" | undefined) =>
  (annotation.side === "old") === (side === "old");

/**
 * A file's code annotations in the thread's draft, for an editor showing it (the file as it is,
 * or a diff's old side), and the draft's port to save and move them. No port while the thread's
 * composer isn't mounted (a new thread's draft): there is nowhere for an annotation to wait.
 */
export function useCodeAnnotations(
  threadId: string | undefined,
  path: string,
  side?: "old" | "new" | undefined,
) {
  const port = useComposerPort(threadId ?? "");
  const subscribe = useCallback(
    (listener: () => void) => port?.subscribe(listener) ?? quiet(),
    [port],
  );
  const all = useSyncExternalStore(subscribe, () => port?.code() ?? none);
  const annotations = useMemo(
    () => all.filter((each) => each.path === path && onSide(each, side)),
    [all, path, side],
  );
  return { port, annotations };
}

/** Lets the composer's list reopen this editor's annotations while it is mounted. */
export function useCodeEditorPort(
  threadId: string | undefined,
  path: string,
  side: "old" | "new" | undefined,
  edit: CodeEditorPort["edit"],
): void {
  const latest = useRef(edit);
  useLayoutEffect(() => {
    latest.current = edit;
  });
  useEffect(() => {
    if (!threadId) return;
    return codeEditors.register(threadId, {
      path,
      ...(side === "old" ? { side } : {}),
      edit: (id) => latest.current(id),
    });
  }, [threadId, path, side]);
}
