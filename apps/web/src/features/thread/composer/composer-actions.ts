import { useEffect, useLayoutEffect, useRef } from "react";
import { useLayout } from "@/lib/layout.tsx";

/**
 * Registers what this thread's composer can do when asked from elsewhere (the palette): Stop,
 * as its own Stop does, and opening the model chip on its list or its effort slider. The
 * registration changes only when the thread or whether it can stop does; each call runs the
 * composer's latest handler.
 */
export function useComposerActions(
  threadId: string,
  stop: (() => void) | undefined,
  open: {
    chooseModel(): void;
    tuneEffort(): void;
    approve(interactionId: string, optionId: string): void;
  },
): void {
  const { setComposerActions } = useLayout();
  const latest = useRef({ stop, open });
  useLayoutEffect(() => {
    latest.current = { stop, open };
  });
  const canStop = stop !== undefined;
  useEffect(() => {
    setComposerActions({
      scope: threadId,
      stop: canStop ? () => latest.current.stop?.() : undefined,
      chooseModel: () => latest.current.open.chooseModel(),
      tuneEffort: () => latest.current.open.tuneEffort(),
      approve: (interactionId, optionId) => latest.current.open.approve(interactionId, optionId),
    });
    return () => setComposerActions(undefined);
  }, [threadId, canStop, setComposerActions]);
}
