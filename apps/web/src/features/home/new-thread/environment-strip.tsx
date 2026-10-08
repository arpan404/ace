import type { WorktreeBase } from "@ace/protocol";
import { baseName } from "@ace/ui-core";
import { CaretDownIcon, GitBranchIcon, LaptopIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import {
  AttachedCard,
  composerStrip,
  composerStripRow,
  useComposerCompact,
} from "@/features/thread/index.ts";
import type { BaseRefs } from "@/lib/branches.ts";
import { cn } from "@/lib/cn.ts";
import { useHostName } from "@/lib/host-name.ts";
import { BasePicker } from "./base-picker.tsx";
import type { WorkMode } from "./choices.ts";
import { ProjectPicker } from "./project-picker.tsx";

/**
 * Where a new thread runs, on the tab attached to the composer: the project, the machine, a
 * Worktree toggle (a branch and folder of its own, or the project's checkout as it is) and, for
 * a worktree, the branch it starts from, local or on a remote, found by typing. The remote's
 * copy of the default branch is offered first; it is fetched just before the worktree is made.
 * A narrow composer keeps the machine's icon alone.
 */
export function NewThreadEnvironment(props: {
  projects: readonly string[];
  projectName(id: string): string;
  project: string | undefined;
  onProject(project: string): void;
  mode: WorkMode;
  onMode(mode: WorkMode): void;
  branches: BaseRefs;
  base: WorktreeBase | undefined;
  onBase(base: WorktreeBase): void;
}) {
  const compact = useComposerCompact();
  const host = useHostName() ?? "This machine";
  const [choosing, setChoosing] = useState(false);
  const worktree = props.mode === "worktree";
  const base = props.base ? baseName(props.base) : "the current branch";
  return (
    <AttachedCard label="Where this thread runs" strip cardKey="new-thread">
      <div className={composerStripRow}>
        <ProjectPicker
          projects={props.projects}
          projectName={props.projectName}
          project={props.project}
          onProject={props.onProject}
        />
        <Tip label={`Runs on ${host}`} side="top">
          <span className="flex h-7 min-w-0 items-center gap-1.5 px-2">
            <LaptopIcon aria-hidden size={14} className="shrink-0" />
            {compact ? (
              <span className="sr-only">{host}</span>
            ) : (
              <span className="truncate">{host}</span>
            )}
          </span>
        </Tip>
        <span className="flex-1" />
        <Tip
          label={
            worktree
              ? "A branch and folder of its own; your checkout stays as it is"
              : "Works in the project's folder, on its current branch"
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
          <Popover open={choosing} onOpenChange={setChoosing}>
            <Tip label="The branch it starts from" side="top">
              <PopoverTrigger
                aria-label={`Start from: ${base}`}
                className={cn(composerStrip, "max-w-32 text-foreground")}
              >
                <GitBranchIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{base}</span>
                <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
              </PopoverTrigger>
            </Tip>
            <PopoverContent
              side="top"
              align="end"
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
        )}
      </div>
    </AttachedCard>
  );
}
