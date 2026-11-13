import { botFaceMotion, botFaceStateAfter, type BotFaceState } from "@ace/ui-core/bot-face";
import { useEffect, useRef, useState } from "react";

/**
 * The state a bot's face shows for its live state: new work is acknowledged for a moment, and
 * finished work shows done until `seen` (the person is looking at that conversation, say) or
 * the state moves again.
 */
export function useFaceState(live: BotFaceState | null, seen = false): BotFaceState {
  const previous = useRef(live);
  const [shown, setShown] = useState<BotFaceState>(live ?? "idle");
  useEffect(() => {
    const before = previous.current;
    previous.current = live;
    if (before === live) return;
    const next = live === null ? "idle" : before === null ? live : botFaceStateAfter(before, live);
    setShown(next);
    if (live === null || next !== "acknowledge") return;
    const timer = setTimeout(() => setShown(live), botFaceMotion.acknowledge.ms);
    return () => clearTimeout(timer);
  }, [live]);
  useEffect(() => {
    if (seen && shown === "done") {
      const timer = setTimeout(() => setShown("idle"), botFaceMotion.done.ms * 3);
      return () => clearTimeout(timer);
    }
  }, [seen, shown]);
  return live === null ? "idle" : shown;
}
