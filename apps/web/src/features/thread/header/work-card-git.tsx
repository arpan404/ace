import { useThreadMeta } from "@ace/client-react";
import { baseRecordText, checkoutNote } from "@ace/ui-core";
import { GitBranchIcon, GitDiffIcon } from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";
import type { useGitFlow } from "./use-git-flow.tsx";
import { BranchItems } from "./work-card-branches.tsx";
import { GitAction } from "./git-action.tsx";
import { Section, RowButton, RowCaret, RowLabel, RowStatic, rowIcon } from "./work-card-parts.tsx";
import { PrLine } from "./work-card-pr.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

/**
 * The branch, the next git step, its uncommitted changes, its pull request and how it stands.
 * The changes row names its scope (Uncommitted) and opens Changes on that scope, so its count
 * and the Changes header's always describe the same thing.
 */
export function GitGroup(props: {
  thread: ThreadRef;
  git: GitFlow;
  move(move: Move): void;
  onClose(): void;
}) {
  const { git } = props;
  const workspace = useWorkspaceActions(props.thread.id);
  const checkout = git.checkout;
  const note = checkout && checkoutNote(checkout);
  return (
    <Section label="Git">
      <BranchRow thread={props.thread} git={git} move={props.move} />
      {checkout && (
        <>
          <GitAction git={git} checkout={checkout} />
          <RowButton
            aria-label={`Uncommitted changes, ${checkout.changed} files: ${checkout.additions} added, ${checkout.deletions} removed`}
            onClick={() => {
              workspace.open({ kind: "changes", data: { scope: "working-tree" } });
              props.onClose();
            }}
          >
            <GitDiffIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>Uncommitted</RowLabel>
            {checkout.changed > 0 ? (
              <DiffStat
                additions={checkout.additions}
                deletions={checkout.deletions}
                className="text-xs"
              />
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
            <RowCaret to="elsewhere" />
          </RowButton>
          <PrLine
            git={git}
            threadId={props.thread.id}
            workspaceId={props.thread.workspaceId}
            onClose={props.onClose}
          />
          {note && (
            <output className="mx-1 my-0.5 flex h-[26px] items-center gap-2 rounded-sm bg-accent/60 px-2 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-needs-you" />
              {note}
            </output>
          )}
        </>
      )}
    </Section>
  );
}

/** The current branch opens the guarded branch switcher. */
function BranchRow(props: { thread: ThreadRef; git: GitFlow; move(move: Move): void }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const base = details?.base ? baseRecordText(details.base) : undefined;
  const { checkout, state } = props.git;
  if (!checkout)
    return (
      <RowStatic>
        <GitBranchIcon aria-hidden size={16} className={rowIcon} />
        {state === "loading" ? (
          <>
            <Spinner /> <RowLabel>Reading the checkout</RowLabel>
          </>
        ) : (
          <RowLabel className="text-muted-foreground">Not a git checkout</RowLabel>
        )}
      </RowStatic>
    );
  const branch = checkout.branch ?? "detached HEAD";
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton aria-label={`Branch ${branch}, switch branch`}>
            <GitBranchIcon aria-hidden size={16} className={rowIcon} />
            <Tip
              label={`${branch} → ${checkout.baseBranch}${base?.note ? ` · ${base.text}. ${base.note}` : ""}`}
            >
              <RowLabel className="font-mono text-xs">{branch}</RowLabel>
            </Tip>
            <RowCaret />
          </RowButton>
        }
      />
      <MenuContent align="end" className="max-h-(--available-height) overflow-y-auto">
        <BranchItems thread={props.thread} move={props.move} />
      </MenuContent>
    </Menu>
  );
}
