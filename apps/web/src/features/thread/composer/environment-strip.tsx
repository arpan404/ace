import { useThreadMeta } from "@ace/client-react";
import { useMachineName } from "@/lib/host-name.ts";
import { CaretDownIcon, GitBranchIcon, GitForkIcon, LaptopIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { AttachedCard } from "./attached-card.tsx";
import { useComposerCompact } from "./composer-compact.ts";
import { stripControl, stripRow } from "./composer-styles.ts";

/**
 * Where a follow-up runs, in the composer's tab while the agent is idle: the branch (on its own
 * worktree or the local checkout) and the machine, quiet until hovered. It raises the
 * environment's details in its place. A narrow composer keeps the machine's icon alone.
 */
export function EnvironmentStrip(props: {
  thread: ThreadRef;
  onOpen(): void;
  /** The details card it raises, for `aria-controls`. */
  controls: string;
}) {
  const checkout = useCheckout(props.thread);
  const host = useMachineName(useThreadMeta(props.thread.id)?.details?.machine);
  const compact = useComposerCompact();
  if (!checkout) return null;
  const worktree = checkout.mode === "worktree";
  const branch = checkout.branch ?? "detached HEAD";
  const Place = worktree ? GitForkIcon : GitBranchIcon;
  return (
    <AttachedCard label="Environment" strip cardKey="environment">
      <div className={stripRow}>
        <Tip label="Where this thread runs" side="top">
          <button
            type="button"
            aria-label={`Environment: ${worktree ? "Worktree" : "Local"} · ${branch}`}
            aria-expanded={false}
            aria-controls={props.controls}
            onClick={props.onOpen}
            className={cn(stripControl, "max-w-full")}
          >
            <Place aria-hidden size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{branch}</span>
            {host && (
              <>
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <LaptopIcon aria-hidden size={14} className="shrink-0" />
                {!compact && <span className="shrink-0">{host}</span>}
              </>
            )}
            <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          </button>
        </Tip>
      </div>
    </AttachedCard>
  );
}
