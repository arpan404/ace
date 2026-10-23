import { Link } from "@tanstack/react-router";
import { GithubMark } from "@/components/github-mark.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The one GitHub button beside Settings at the sidebar's foot. It opens the list last looked at
 * (Inbox, Pull requests or Issues), lit while one of those pages is open. A needs-you dot shows
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
    <Tip label={parts.length ? `GitHub · ${parts.join(" · ")}` : "GitHub"}>
      <Link
        to={props.to}
        aria-current={props.active ? "page" : undefined}
        aria-label={said}
        className={cn(
          "relative grid size-8 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground",
          props.active && "bg-sidebar-accent text-foreground",
        )}
      >
        {/* The mark fills its box; the gear beside it draws 13px tall in 16, so this matches it. */}
        <GithubMark size={13.5} />
        {waiting > 0 && (
          <span
            aria-hidden
            data-tone="needs-you"
            className="absolute top-1 right-1 size-1.5 rounded-full bg-(--tone) ring-2 ring-sidebar"
          />
        )}
      </Link>
    </Tip>
  );
}
