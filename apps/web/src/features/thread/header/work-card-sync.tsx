import { syncWords, uncommittedWords, type Checkout } from "@ace/ui-core";
import { CloudArrowUpIcon } from "@phosphor-icons/react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { GitMenuItems } from "./git-action.tsx";
import type { useGitFlow } from "./use-git-flow.tsx";
import {
  RowCaret,
  RowLabel,
  RowSplit,
  rowIcon,
  splitCaret,
  splitMain,
} from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

/**
 * The branch against its remote ("Up to date with origin", "2 to push") and its uncommitted
 * changes as a quiet value on the right ("No changes", "3 files"), which opens them in Changes.
 * The words and the caret open every git step, the next one marked.
 */
export function SyncRow(props: { git: GitFlow; checkout: Checkout; onOpenChanges(): void }) {
  const { git, checkout } = props;
  const words = syncWords(checkout);
  const changed = checkout.changed > 0;
  return (
    <Menu>
      <RowSplit>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`${words}, git actions`}
              disabled={git.pending}
              className={splitMain}
            >
              <CloudArrowUpIcon aria-hidden size={16} className={rowIcon} />
              <RowLabel>{words}</RowLabel>
              {git.pending && <Spinner />}
            </button>
          }
        />
        <button
          type="button"
          aria-label={
            changed
              ? `Uncommitted changes, ${checkout.changed} files: ${checkout.additions} added, ${checkout.deletions} removed`
              : "Uncommitted changes, none"
          }
          onClick={props.onOpenChanges}
          className={cn(
            "focus-ring h-6 shrink-0 rounded-sm px-1.5 text-xs transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground",
            changed ? "text-foreground" : "text-subtle-foreground",
          )}
        >
          {uncommittedWords(checkout)}
        </button>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="More git actions"
              title="Commit, push, create PR"
              disabled={git.pending}
              className={splitCaret}
            >
              <RowCaret />
            </button>
          }
        />
      </RowSplit>
      <MenuContent align="end" className="w-[240px]">
        <GitMenuItems git={git} checkout={checkout} />
      </MenuContent>
    </Menu>
  );
}
