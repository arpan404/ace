import { isSettled } from "@ace/client/worktree-creations";
import type { WorktreeCreationProgress } from "@ace/protocol";
import { worktreeCurrentStep, worktreeTabLabel } from "@ace/ui-core";
import { GitForkIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { AttachedCard } from "../composer/attached-card.tsx";
import { useComposerCompact } from "../composer/composer-compact.ts";
import { stripRow } from "../composer/composer-styles.ts";

/**
 * The composer's tab while a new thread's worktree is made: "Creating worktree… · Checking out
 * files · 48%", then how it ended. The step drops on a narrow composer. It reads the same
 * progress as the card in the transcript, so the two never disagree.
 */
export function WorktreeStrip(props: { progress: WorktreeCreationProgress | undefined }) {
  const compact = useComposerCompact();
  const { progress } = props;
  const failed = progress?.state === "failed";
  const current = worktreeCurrentStep(progress);
  return (
    <AttachedCard label="Worktree" strip cardKey="worktree">
      <div className={cn(stripRow, "gap-2 pl-3.5")}>
        {!progress || !isSettled(progress) ? (
          <Spinner />
        ) : (
          <Icon
            icon={failed ? WarningCircleIcon : GitForkIcon}
            size={14}
            className={failed ? "text-status-failed" : "text-subtle-foreground"}
          />
        )}
        <p role="status" className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-foreground">{worktreeTabLabel(progress)}</span>
          {!compact && current && (
            <span className="min-w-0 truncate text-subtle-foreground">· {current}</span>
          )}
        </p>
      </div>
    </AttachedCard>
  );
}
