import { CaretDownIcon, SparkleIcon, XIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import { cn } from "@/lib/cn.ts";
import { canCommitChanges } from "./source-control-model.ts";

/**
 * Commit composer at the top of Source control: multi-line commit message box (⌘↵ commits),
 * inline bare-icon Write message action (`git.draft.generate`), and a primary Commit split button
 * with a menu for Commit and push and Amend.
 */
export function CommitBox(props: {
  message: string;
  onMessageChange(value: string): void;
  stagedCount: number;
  changesCount: number;
  conflictsCount: number;
  disabled: boolean;
  committing: boolean;
  drafting: boolean;
  onWriteMessage(): void;
  onCancelDraft(): void;
  onCommit(mode: "commit" | "commit-and-push" | "amend"): void;
}) {
  const canCommit =
    !props.disabled &&
    !props.committing &&
    canCommitChanges({
      message: props.message,
      stagedCount: props.stagedCount,
      changesCount: props.changesCount,
      conflictsCount: props.conflictsCount,
      amend: false,
    });

  const canAmend =
    !props.disabled &&
    !props.committing &&
    canCommitChanges({
      message: props.message,
      stagedCount: props.stagedCount,
      changesCount: props.changesCount,
      conflictsCount: props.conflictsCount,
      amend: true,
    });

  const hasAnyChanges = props.stagedCount > 0 || props.changesCount > 0;
  const commitShortcut = applePlatform ? "⌘↵" : "Ctrl+Enter";
  const commitLabel =
    props.stagedCount > 0
      ? `Commit ${props.stagedCount} staged ${props.stagedCount === 1 ? "file" : "files"}`
      : "Commit";

  return (
    <div
      data-part="source-control-commit"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-2"
    >
      <div className="relative">
        <Textarea
          aria-label="Commit message"
          placeholder={`Message (${commitShortcut} to commit)`}
          rows={2}
          value={props.message}
          disabled={props.disabled || props.committing}
          onChange={(event) => props.onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (canCommit) props.onCommit("commit");
            }
          }}
          className="min-h-14 py-1.5 pr-8 text-xs leading-4.5"
        />
        <div className="absolute top-1 right-1">
          {props.drafting ? (
            <Tip label="Cancel writing message">
              <button
                type="button"
                aria-label="Cancel writing message"
                onClick={props.onCancelDraft}
                className="inline-grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground focus-ring"
              >
                <span className="sr-only">Writing message</span>
                <Icon icon={XIcon} size={13} />
              </button>
            </Tip>
          ) : (
            <IconButton
              icon={SparkleIcon}
              label="Write message"
              size="sm"
              disabled={props.disabled || props.committing || !hasAnyChanges}
              reason={hasAnyChanges ? undefined : "No changes to describe"}
              onClick={props.onWriteMessage}
              className="size-6 rounded-sm hover:bg-hover"
            />
          )}
        </div>
      </div>

      {props.drafting && (
        <p role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          Writing commit message…
        </p>
      )}

      <div className="flex items-stretch">
        <Tip label={commitLabel} keys="mod+enter" resolve={false}>
          <Button
            variant="primary"
            size="sm"
            disabled={!canCommit}
            onClick={() => props.onCommit("commit")}
            className={cn("h-7 min-w-0 flex-1 rounded-r-none text-xs")}
          >
            {props.committing ? (
              <>
                <Spinner className="size-3" />
                Committing…
              </>
            ) : (
              "Commit"
            )}
          </Button>
        </Tip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="primary"
                size="sm"
                aria-label="More commit actions"
                disabled={props.disabled || props.committing}
                className="h-7 w-7 rounded-l-none border-l border-tint-foreground/20 px-0"
              >
                <Icon icon={CaretDownIcon} size={12} />
              </Button>
            }
          />
          <MenuContent align="end">
            <MenuItem disabled={!canCommit} onClick={() => props.onCommit("commit-and-push")}>
              Commit and push
            </MenuItem>
            <MenuItem disabled={!canAmend} onClick={() => props.onCommit("amend")}>
              Amend
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}
