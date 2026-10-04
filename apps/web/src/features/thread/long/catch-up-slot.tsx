import { CatchUpCard } from "./catch-up-card.tsx";
import { useCatchUp, useReadMarker } from "./catch-up.ts";
import { useThreadNav } from "./nav.tsx";

/**
 * The catch-up card while there is news since this device last read the thread, and the read
 * cursor that advances while the reader follows the live end. Loaded after first paint: marking
 * a thread read a moment later loses nothing.
 */
export function CatchUpSlot(props: { threadId: string }) {
  const nav = useThreadNav();
  const { ready, catchUp, dismiss } = useCatchUp(props.threadId);
  useReadMarker(props.threadId, nav, ready);
  if (!catchUp) return null;
  return (
    <CatchUpCard
      threadId={props.threadId}
      catchUp={catchUp}
      onDismiss={dismiss}
      onLive={() => {
        dismiss();
        nav.jump.live();
      }}
    />
  );
}
