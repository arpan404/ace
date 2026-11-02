import { Link } from "@tanstack/react-router";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { railDotClass, railPlaceClass } from "./rail-place.ts";

/**
 * Code review in the sidebar's rail. It opens the list last looked at (Inbox, Pull requests or
 * Issues), the current place while one of those pages is open. Away from it, its dot is in the
 * warning colour while pull requests wait on the person, else blue while notifications are
 * unread; none at all when nothing waits, and none while Code review is open, as Threads' and
 * Chats' dots.
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
  const said = parts.length ? `Code review, ${parts.join(", ")}` : "Code review";
  return (
    <Tip
      label={parts.length ? `Code review · ${parts.join(" · ")}` : "Code review"}
      shortcut="goPullRequests"
    >
      <Link
        to={props.to}
        aria-current={props.active ? "page" : undefined}
        aria-label={said}
        className={railPlaceClass}
      >
        <Icon icon={GitPullRequestIcon} size={20} active={props.active} />
        {/* As Threads' and Chats' dots: only off the place, where it says there is news. */}
        {!props.active && (waiting > 0 || unread > 0) && (
          <span
            aria-hidden
            data-tone={waiting > 0 ? "needs-you" : "unread"}
            className={railDotClass}
          />
        )}
      </Link>
    </Tip>
  );
}
