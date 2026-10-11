import { useThreadMeta } from "@ace/client-react";
import { baseRecordText, type Checkout } from "@ace/ui-core";
import {
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  CaretDownIcon,
  GitPullRequestIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { Menu, MenuContent, MenuTrigger, MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { BranchItems } from "./work-card-branches.tsx";
import type { Move } from "./checkout-move.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { useGitFlow } from "./use-git-flow.tsx";
import { RowButton, RowNote, rowIcon } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/** The current branch opens a focused, guarded branch switcher. */
export function BranchRow(props: { thread: ThreadRef; git: GitFlow; move(move: Move): void }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const base = details?.base ? baseRecordText(details.base) : undefined;
  const { checkout, state } = props.git;
  if (!checkout)
    return (
      <RowNote>
        <GitBranchIcon aria-hidden size={16} className={rowIcon} />
        {state === "loading" ? (
          <>
            <Spinner /> Reading the checkout
          </>
        ) : (
          "Not a git checkout"
        )}
      </RowNote>
    );
  const branch = checkout.branch ?? "detached HEAD";
  return (
    <Menu>
      <MenuTrigger
        render={
          <RowButton aria-label={`Branch ${branch}, switch branch`}>
            <GitBranchIcon aria-hidden size={16} className={rowIcon} />
            <Tip
              label={`${branch} → ${checkout.baseBranch}, ${checkout.ahead} ahead${checkout.behind ? `, ${checkout.behind} behind` : ""}${base?.note ? ` · ${base.text}. ${base.note}` : ""}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
            </Tip>
            <CaretDownIcon aria-hidden size={12} className={rowIcon} />
          </RowButton>
        }
      />
      <MenuContent align="end" className="max-h-(--available-height) overflow-y-auto">
        <BranchItems thread={props.thread} move={props.move} />
      </MenuContent>
    </Menu>
  );
}

/** Commit presets and the diff entry point share the existing git flow. */
export function ChangesSection(props: { thread: ThreadRef; git: GitFlow; onClose(): void }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const git = {
    ...props.git,
    open: (kind: Parameters<GitFlow["open"]>[0]) => {
      props.git.open(kind);
      props.onClose();
    },
  };
  const checkout = git.checkout;
  if (!checkout) return null;
  return (
    <>
      <div className="flex min-w-0 items-center">
        <RowButton
          className="flex-1"
          disabled={git.pending || checkout.changed === 0}
          aria-description={
            checkout.changed === 0
              ? "No changes to commit. Use the menu to push or create a PR."
              : undefined
          }
          onClick={() => git.open("commit-push")}
        >
          <UploadSimpleIcon aria-hidden size={16} className={rowIcon} />
          Commit &amp; push
        </RowButton>
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={CaretDownIcon}
                label="Commit and push options"
                size="sm"
                disabled={git.pending}
              />
            }
          />
          <MenuContent align="end">
            <GitMenuItems git={git} checkout={checkout} />
          </MenuContent>
        </Menu>
      </div>
      <RowButton
        aria-label={`Changes, ${checkout.changed} files: ${checkout.additions} added, ${checkout.deletions} removed`}
        onClick={() => {
          workspace.open({ kind: "changes" });
          props.onClose();
        }}
      >
        <GitDiffIcon aria-hidden size={16} className={rowIcon} />
        <span className="min-w-0 flex-1">Changes</span>
        <DiffStat additions={checkout.additions} deletions={checkout.deletions} />
        {checkout.changed === 0 && (
          <span className="text-xs text-subtle-foreground">Up to date</span>
        )}
      </RowButton>
    </>
  );
}

export function GitMenuItems(props: { git: GitFlow; checkout: Checkout }) {
  const { git, checkout } = props;
  return (
    <>
      {checkout.changed > 0 && (
        <>
          <MenuItem
            icon={glyph(GitCommitIcon)}
            disabled={git.pending}
            onClick={() => git.open("commit")}
          >
            Commit only…
          </MenuItem>
          <MenuItem
            icon={glyph(GitCommitIcon)}
            disabled={git.pending}
            onClick={() => git.open("commit-push")}
          >
            Commit &amp; push…
          </MenuItem>
        </>
      )}
      {checkout.branch && (
        <MenuItem
          icon={glyph(UploadSimpleIcon)}
          disabled={!checkout.branch || git.pending}
          onClick={git.push}
        >
          Push
        </MenuItem>
      )}
      {checkout.pr?.state !== "merged" &&
        checkout.pr?.state !== "open" &&
        checkout.pr?.state !== "draft" && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={glyph(GitPullRequestIcon)}
              disabled={!!git.draftBlocked || git.pending}
              aria-description={git.draftBlocked}
              title={git.draftBlocked}
              onClick={() => git.open("pr")}
            >
              Create PR…
            </MenuItem>
            <MenuItem
              icon={glyph(GitPullRequestIcon)}
              disabled={!!git.draftBlocked || git.pending}
              aria-description={git.draftBlocked}
              title={git.draftBlocked}
              onClick={() => git.open("draft-pr")}
            >
              Create draft PR…
            </MenuItem>
          </>
        )}
    </>
  );
}
