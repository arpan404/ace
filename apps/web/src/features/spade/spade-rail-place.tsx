import { Link } from "@tanstack/react-router";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { spadeNeedsYouCount } from "./spade-list-rows.ts";
import { useSpadeGroups } from "./use-spade-groups.ts";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const needWord = (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`;

/**
 * Spade in the rail: its mark, back to where the person last was in Spade. While they are
 * elsewhere and a bot or group waits on them (the list's needs-you rows), a needs-you dot, and
 * its name says how many.
 */
export function SpadeRailPlace(props: { current: boolean; to: string; search: object }) {
  const ready = useSpadeStatus()?.state === "ready";
  const roster = useSpadeRoster(ready);
  const { groups } = useSpadeGroups(roster);
  const waiting = props.current ? 0 : spadeNeedsYouCount(roster.bots, groups);
  const asks = waiting ? needWord(waiting) : "";
  return (
    <Tip label={asks ? `Spade · ${asks}` : "Spade"}>
      <Link
        to={props.to}
        search={props.search}
        aria-label={asks ? `Spade, ${asks}` : "Spade"}
        aria-current={props.current ? "page" : undefined}
        data-state={props.current ? "active" : undefined}
        data-part="rail-item"
        className={railPlaceClass}
      >
        <SpadeMark size={20} />
        {waiting > 0 && <span aria-hidden data-tone="needs-you" className={railDotClass} />}
      </Link>
    </Tip>
  );
}
