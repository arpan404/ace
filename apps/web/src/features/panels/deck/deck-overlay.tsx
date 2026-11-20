import { useEffect } from "react";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { QuickOpenOverlay } from "../files/quick-open-overlay.tsx";
import { onDeckClose } from "./deck-close.ts";
import { deckKind } from "./deck-layout.ts";
import { UnsavedPrompt } from "./unsaved-prompt.tsx";

/**
 * Drawn once per thread screen with the kinds: ⌘P's quick open, the Deck's unsaved-changes
 * questions, and the way an answered close of the Deck tab finishes.
 */
export function DeckOverlay(props: { scope: string }) {
  const actions = useWorkspaceActions(props.scope);
  useEffect(
    () => onDeckClose(props.scope, () => void actions.close(deckKind)),
    [actions, props.scope],
  );
  return (
    <>
      <QuickOpenOverlay scope={props.scope} />
      <UnsavedPrompt />
    </>
  );
}
