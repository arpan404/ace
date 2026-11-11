import { Link } from "@tanstack/react-router";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useSpadeConversations } from "./use-spade-conversations.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const needWord = (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`;

/**
 * Spade in the rail: its mark, back to where the person last was in Spade. While they are
 * elsewhere and an approval waits in a conversation, a needs-you dot, and its name says how many.
 */
export function SpadeRailPlace(props: { current: boolean; to: string; search: object }) {
  const ready = useSpadeStatus()?.state === "ready";
  const rows = useSpadeConversations(ready).data ?? [];
  const waiting = props.current ? 0 : rows.filter((row) => row.waitingOnYou).length;
  const asks = waiting ? needWord(waiting) : "";
  return (
    <Tip label={asks ? `Spade · ${asks}` : "Spade"}>
      <Link
        to={props.to}
        search={props.search}
        aria-label={asks ? `Spade, ${asks}` : "Spade"}
        aria-current={props.current ? "page" : undefined}
        className={railPlaceClass}
      >
        <SpadeMark size={20} />
        {waiting > 0 && <span aria-hidden data-tone="needs-you" className={railDotClass} />}
      </Link>
    </Tip>
  );
}
