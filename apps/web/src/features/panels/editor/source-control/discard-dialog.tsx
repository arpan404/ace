import { WarningCircleIcon } from "@ace/icons";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { splitPath, type SourceControlItem } from "./source-control-model.ts";

export interface DiscardRequest {
  /** Specific items to discard, or all unstaged/untracked changes when `all` is true. */
  readonly items: readonly SourceControlItem[];
  readonly all: boolean;
}

/**
 * Destructive confirmation for discarding file changes. Names the file (or lists the count when
 * discarding several), clarifies that untracked files move to Recently deleted, and requires an
 * explicit second confirmation step when any target file was changed by the agent in its last
 * turn.
 */
export function DiscardDialog(props: {
  request: DiscardRequest;
  agentEditedPaths: readonly string[];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { request, agentEditedPaths, busy } = props;
  const hasAgentEdits = agentEditedPaths.length > 0;
  const [agentStepConfirmed, setAgentStepConfirmed] = useState(false);

  const count = request.items.length;
  const single = count === 1 ? request.items[0] : undefined;
  const untrackedCount = request.items.filter((item) => item.untracked).length;
  const trackedCount = count - untrackedCount;

  const title =
    hasAgentEdits && agentStepConfirmed
      ? "Discard the agent's latest edits?"
      : single
        ? `Discard changes to ${splitPath(single.path).name}?`
        : request.all
          ? `Discard all ${count} changed files?`
          : `Discard changes to ${count} files?`;

  const description = (() => {
    if (hasAgentEdits && agentStepConfirmed) {
      const names = agentEditedPaths.map((path) => splitPath(path).name);
      const list =
        names.length <= 3
          ? names.join(", ")
          : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
      return `The agent edited ${list} in its last turn. Discarding reverts that work too.`;
    }
    if (single) {
      return single.untracked
        ? `${single.path} is untracked and will be moved to Recently deleted.`
        : `Your unstaged edits to ${single.path} will be reverted. The edited file goes to Recently deleted.`;
    }
    if (untrackedCount > 0 && trackedCount > 0) {
      return `${trackedCount} tracked ${trackedCount === 1 ? "file" : "files"} will be reverted and ${untrackedCount} untracked ${untrackedCount === 1 ? "file" : "files"} will be moved to Recently deleted.`;
    }
    if (untrackedCount > 0) {
      return `${untrackedCount} untracked ${untrackedCount === 1 ? "file" : "files"} will be moved to Recently deleted.`;
    }
    return `Unstaged edits to ${count} files will be reverted. The edited files go to Recently deleted.`;
  })();

  const handlePrimary = () => {
    if (hasAgentEdits && !agentStepConfirmed) {
      setAgentStepConfirmed(true);
      return;
    }
    props.onConfirm();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent material="glass">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {hasAgentEdits && !agentStepConfirmed && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-status-needs-you/40 bg-status-needs-you/10 px-3 py-2 text-xs leading-4 text-foreground"
          >
            <Icon
              icon={WarningCircleIcon}
              size={14}
              className="mt-0.5 shrink-0 text-status-needs-you"
            />
            <span>
              The agent changed{" "}
              {agentEditedPaths.length === 1
                ? splitPath(agentEditedPaths[0] ?? "").name
                : `${agentEditedPaths.length} of these files`}{" "}
              in its last turn. You will be asked to confirm one more time.
            </span>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
          {hasAgentEdits && !agentStepConfirmed ? (
            <Button variant="secondary" disabled={busy} onClick={handlePrimary}>
              Continue
            </Button>
          ) : (
            <Button variant="danger" disabled={busy} onClick={handlePrimary}>
              {hasAgentEdits ? "Discard anyway" : single?.untracked ? "Move to trash" : "Discard"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
