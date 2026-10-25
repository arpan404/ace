import type { WorktreeBase } from "@ace/protocol";
import { baseName } from "@ace/ui-core";
import { CaretDownIcon, GitBranchIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { composerStrip } from "@/features/thread/index.ts";
import type { BaseRefs } from "@/lib/branches.ts";
import { cn } from "@/lib/cn.ts";
import { BasePicker } from "./base-picker.tsx";
import type { WorkMode } from "./choices.ts";

const divider = <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />;

/**
 * Where a new thread runs, as one compact row in the composer's top strip (never inside the box,
 * never below it): a Worktree toggle (a branch and folder of its own, or the project's checkout
 * as it is) and, for a worktree, the branch it starts from, local or on a remote, found by
 * typing. The machine is a line under the page's question (`MachineLine`).
 */
export function NewThreadEnvironment(props: {
  pullRequest?: { number?: number | undefined; headSha?: string | undefined } | undefined;
  mode: WorkMode | undefined;
  onMode(mode: WorkMode): void;
  /** Why this project can't have a worktree ("Not a Git repository"), when it can't. */
  noWorktree?: string | undefined;
  branches: BaseRefs;
  base: WorktreeBase | undefined;
  onBase(base: WorktreeBase): void;
  /** Where focus goes when the branch list closes: the message. */
  returnFocus(): HTMLElement | null;
}) {
  const [choosing, setChoosing] = useState(false);
  const worktree = props.mode === "worktree";
  const reading = !props.base && props.branches.state === "loading";
  const base = props.base ? baseName(props.base) : reading ? "Reading branches…" : "Current branch";
  return (
    <section
      aria-label="Where this thread runs"
      className="flex min-w-0 flex-1 items-center gap-0.5 text-xs text-muted-foreground"
    >
      {props.pullRequest ? (
        <p className="min-w-0 truncate px-2">
          Isolated worktree · PR #{props.pullRequest.number ?? "…"} ·{" "}
          {props.pullRequest.headSha?.slice(0, 12) ?? "Resolving head…"}
        </p>
      ) : (
        <>
          <Tip
            label={
              props.noWorktree ??
              (worktree
                ? "A branch and folder of its own; your checkout stays as it is"
                : "In the project's folder, on its current branch")
            }
            side="top"
          >
            <label
              className={cn(
                composerStrip,
                "shrink-0 cursor-default",
                props.noWorktree && "text-subtle-foreground hover:bg-transparent",
              )}
            >
              <span>Worktree</span>
              <Checkbox
                checked={worktree}
                disabled={props.noWorktree !== undefined || props.mode === undefined}
                aria-description={props.noWorktree}
                onCheckedChange={(checked) => props.onMode(checked ? "worktree" : "local")}
              />
            </label>
          </Tip>
          {worktree && (
            <>
              {divider}
              <Popover open={choosing} onOpenChange={setChoosing}>
                <Tip label="The branch it starts from" side="top">
                  <PopoverTrigger
                    aria-label={`Start from: ${base}`}
                    className={cn(composerStrip, "max-w-48 text-foreground")}
                  >
                    <GitBranchIcon
                      aria-hidden
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    {reading ? (
                      <Skeleton className="w-20" />
                    ) : (
                      <span className="min-w-0 truncate">{base}</span>
                    )}
                    <CaretDownIcon
                      aria-hidden
                      size={12}
                      className="shrink-0 text-subtle-foreground"
                    />
                  </PopoverTrigger>
                </Tip>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={10}
                  aria-label="Start from a branch"
                  finalFocus={props.returnFocus}
                  className="w-80 max-w-[calc(100vw-2rem)] p-2"
                >
                  <BasePicker
                    branches={props.branches}
                    base={props.base}
                    onBase={(next) => {
                      setChoosing(false);
                      props.onBase(next);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </>
          )}
        </>
      )}
    </section>
  );
}
