import type { WorktreeBase } from "@ace/protocol";
import { baseName } from "@ace/ui-core";
import { CaretDownIcon, GitBranchIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { MachineLabel, MachineMark } from "@/components/ui/machine-label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { composerStrip, useComposerCompact } from "@/features/thread/index.ts";
import type { BaseRefs } from "@/lib/branches.ts";
import { cn } from "@/lib/cn.ts";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { BasePicker } from "./base-picker.tsx";
import type { WorkMode } from "./choices.ts";

const divider = <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />;

/**
 * Where a new thread runs, as one compact row in the composer's top strip (never inside the box,
 * never below it): the machine, a Worktree toggle (a branch and folder of its own, or the
 * project's checkout as it is) and, for a worktree, the branch it starts from, local or on a
 * remote, found by typing. A narrow composer keeps the machine's icon and drops its name.
 */
export function NewThreadEnvironment(props: {
  pullRequest?: { number?: number | undefined; headSha?: string | undefined } | undefined;
  mode: WorkMode;
  onMode(mode: WorkMode): void;
  branches: BaseRefs;
  base: WorktreeBase | undefined;
  onBase(base: WorktreeBase): void;
}) {
  const compact = useComposerCompact();
  const host = useMachineIdentity();
  const [choosing, setChoosing] = useState(false);
  const worktree = props.mode === "worktree";
  const base = props.base ? baseName(props.base) : "Current branch";
  return (
    <section
      aria-label="Where this thread runs"
      className="flex min-w-0 flex-1 items-center gap-0.5 text-xs text-muted-foreground"
    >
      <Tip label={`Runs on ${host.name}`} side="top">
        <span className={cn(composerStrip, "shrink-0 cursor-default hover:bg-transparent")}>
          {compact ? (
            <MachineMark icon={host.icon} />
          ) : (
            <MachineLabel name={host.name} icon={host.icon} />
          )}
        </span>
      </Tip>
      {divider}
      {props.pullRequest ? (
        <p className="min-w-0 truncate px-2">
          Isolated worktree · PR #{props.pullRequest.number ?? "…"} ·{" "}
          {props.pullRequest.headSha?.slice(0, 12) ?? "Resolving head…"}
        </p>
      ) : (
        <>
          <Tip
            label={
              worktree
                ? "A branch and folder of its own; your checkout stays as it is"
                : "In the project's folder, on its current branch"
            }
            side="top"
          >
            <label className={cn(composerStrip, "shrink-0 cursor-default")}>
              <span>Worktree</span>
              <Checkbox
                checked={worktree}
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
                    <span className="min-w-0 truncate">{base}</span>
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
