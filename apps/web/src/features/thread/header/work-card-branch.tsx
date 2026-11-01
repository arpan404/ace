import { useThreadMeta } from "@ace/client-react";
import { baseRecordText } from "@ace/ui-core";
import { GitBranchIcon } from "@phosphor-icons/react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";
import type { useGitFlow } from "./use-git-flow.tsx";
import { BranchItems } from "./work-card-branches.tsx";
import {
  Section,
  RowAction,
  RowButton,
  RowCaret,
  RowLabel,
  RowStatic,
  rowIcon,
} from "./work-card-parts.tsx";
import { PrLine } from "./work-card-pr.tsx";
import { SyncRow } from "./work-card-sync.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

/**
 * The branch, how it stands against its remote with its uncommitted changes beside it, and its
 * pull request. The changes value opens Changes on the uncommitted scope, so its count and the
 * Changes header's always describe the same thing.
 */
export function BranchGroup(props: {
  thread: ThreadRef;
  git: GitFlow;
  move(move: Move): void;
  onClose(): void;
}) {
  const { git } = props;
  const workspace = useWorkspaceActions(props.thread.id);
  const checkout = git.checkout;
  return (
    <Section label="Branch" title="Branch">
      <BranchRow thread={props.thread} git={git} move={props.move} />
      {checkout && (
        <>
          <SyncRow
            git={git}
            checkout={checkout}
            onOpenChanges={() => {
              workspace.open({ kind: "changes", data: { scope: "working-tree" } });
              props.onClose();
            }}
          />
          <PrLine
            git={git}
            threadId={props.thread.id}
            workspaceId={props.thread.workspaceId}
            onClose={props.onClose}
          />
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
  if (!checkout && state === "error")
    return (
      <>
        <RowStatic label="Couldn't read the checkout">
          <GitBranchIcon aria-hidden size={16} className={rowIcon} />
          <RowLabel className="text-status-failed">Couldn't read the checkout</RowLabel>
          <RowAction onClick={props.git.retry}>Retry</RowAction>
        </RowStatic>
        {props.git.error && (
          <p role="alert" className="mx-2 mb-1 text-xs text-muted-foreground">
            <InlineMarkdown text={props.git.error} />
          </p>
        )}
      </>
    );
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
            {/* The full name where it fits, cut only at the card's edge; the tip names it whole. */}
            <Tip
              label={`${branch} → ${checkout.baseBranch ?? "default branch"}${base?.note ? ` · ${base.text}. ${base.note}` : ""}`}
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
