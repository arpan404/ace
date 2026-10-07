import { GitForkIcon, LaptopIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";

export type Place = "local" | "worktree";

const places: Record<Place, { label: string; icon: typeof LaptopIcon }> = {
  local: { label: "Local", icon: LaptopIcon },
  worktree: { label: "Worktree", icon: GitForkIcon },
};

/**
 * Where a thread runs, in the composer's footer: its own worktree or the local checkout, with
 * the branch beside it in a quieter tone. It opens the environment card above the composer. A
 * narrow composer shows the place's icon alone; the words stay in its name and tooltip.
 */
export function EnvironmentPill(props: {
  place: Place | undefined;
  /** The branch, or the base a new worktree starts from. */
  detail?: string | undefined;
  open: boolean;
  onToggle(): void;
  /** The card it opens, for `aria-controls` while open. */
  controls?: string | undefined;
}) {
  const compact = useComposerCompact();
  const place = props.place ? places[props.place] : undefined;
  const Glyph = place?.icon ?? LaptopIcon;
  const words = [place?.label ?? "Environment", props.detail].filter(Boolean).join(" · ");
  return (
    <Tip label={props.open ? "Close" : "Where this runs"} side="top">
      <button
        type="button"
        aria-label={`Environment: ${words}`}
        aria-expanded={props.open}
        aria-controls={props.open ? props.controls : undefined}
        onClick={props.onToggle}
        className={chipControl}
      >
        <Glyph aria-hidden size={16} className="shrink-0" />
        {!compact && place && <span className="shrink-0">{place.label}</span>}
        {!compact && props.detail && (
          <span className="max-w-40 min-w-0 truncate font-normal text-subtle-foreground">
            {props.detail}
          </span>
        )}
      </button>
    </Tip>
  );
}

/** The thread's own pill: its checkout as the daemon last read it. */
export function ThreadEnvironmentPill(props: {
  thread: ThreadRef;
  open: boolean;
  onToggle(): void;
  controls: string;
}) {
  const checkout = useCheckout(props.thread);
  return (
    <EnvironmentPill
      place={checkout?.mode}
      detail={checkout ? (checkout.branch ?? "detached HEAD") : undefined}
      open={props.open}
      onToggle={props.onToggle}
      controls={props.controls}
    />
  );
}
