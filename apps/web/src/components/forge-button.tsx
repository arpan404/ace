import { Link } from "@tanstack/react-router";
import { GithubMark } from "@/components/github-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { railDotClass, railPlaceClass } from "./rail-place.ts";

/**
 * GitHub in the sidebar's rail. It opens the list last looked at (Inbox, Pull requests or
 * Issues), the current place while one of those pages is open. A needs-you dot shows
 * while pull requests wait on the person; unread notifications only go in its name and tooltip,
 * so they never pull the eye.
 */
export function ForgeButton(props: {
  to: "/pulls" | "/inbox" | "/issues";
  active: boolean;
  /** Pull requests waiting on the person. */
  needsYou?: number | undefined;
  /** Unread GitHub notifications. */
  unread?: number | undefined;
}) {
  const waiting = props.needsYou ?? 0;
  const unread = props.unread ?? 0;
  const parts = [
    waiting > 0 && `${waiting} ${waiting === 1 ? "needs" : "need"} you`,
    unread > 0 && `${unread} unread`,
  ].filter(Boolean);
  const said = parts.length ? `GitHub, ${parts.join(", ")}` : "GitHub";
  return (
    <Tip
      label={parts.length ? `GitHub · ${parts.join(" · ")}` : "GitHub"}
      shortcut="goPullRequests"
    >
      <Link
        to={props.to}
        aria-current={props.active ? "page" : undefined}
        aria-label={said}
        className={railPlaceClass}
      >
        {/* The mark fills its box; the rail's 18px glyphs draw about 15 tall, so this matches. */}
        <GithubMark size={15.5} />
        {waiting > 0 && <span aria-hidden data-tone="needs-you" className={railDotClass} />}
      </Link>
    </Tip>
  );
}
