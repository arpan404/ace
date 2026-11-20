import { useEffect } from "react";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { QuickOpenOverlay } from "../files/quick-open-overlay.tsx";
import { onEditorClose } from "./editor-close.ts";
import { editorKind } from "./editor-layout.ts";
import { UnsavedPrompt } from "./unsaved-prompt.tsx";

/**
 * Drawn once per thread screen with the kinds: ⌘P's quick open, the editor's unsaved-changes
 * questions, and the way an answered close of the editor tab finishes.
 */
export function EditorOverlay(props: { scope: string }) {
  const actions = useWorkspaceActions(props.scope);
  useEffect(
    () => onEditorClose(props.scope, () => void actions.close(editorKind)),
    [actions, props.scope],
  );
  return (
    <>
      <QuickOpenOverlay scope={props.scope} />
      <UnsavedPrompt />
    </>
  );
}
