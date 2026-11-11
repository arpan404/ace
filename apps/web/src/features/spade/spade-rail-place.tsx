import { Link } from "@tanstack/react-router";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const needWord = (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`;

/**
 * Spade in the rail: its mark, back to where the person last was in Spade. While they are
 * elsewhere and a bot waits on them, a needs-you dot, and its name says how many.
 */
export function SpadeRailPlace(props: { current: boolean; to: string; search: object }) {
  const ready = useSpadeStatus()?.state === "ready";
  const { bots } = useSpadeRoster(ready);
  const waiting = props.current
    ? 0
    : bots.filter((bot) => bot.state === "waiting" && !bot.away).length;
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
