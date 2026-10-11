import { useThreadMeta } from "@ace/client-react";
import { baseRecordText, nextGitStep, type Checkout } from "@ace/ui-core";
import {
  DotsThreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { useGitFlow } from "./use-git-flow.tsx";
import { RowButton, RowNote, rowIcon } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/** Branch and changes have separate rows, leaving the full branch its own line. */
export function ChangesSection(props: { thread: ThreadRef; git: GitFlow; onClose(): void }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const details = useThreadMeta(props.thread.id)?.details;
  const base = details?.base ? baseRecordText(details.base) : undefined;
  const git: GitFlow = {
    ...props.git,
    open: (kind) => {
      props.git.open(kind);
      props.onClose();
    },
  };
  const { checkout, state } = git;
  if (!checkout)
    return (
      <RowNote>
        <GitBranchIcon aria-hidden size={14} className={rowIcon} />
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
  const step = nextGitStep(checkout);
  const create = step.kind === "create-pr" && !step.blocked && checkout.pr?.state !== "merged";
  return (
    <section aria-label="Changes and branch">
      <RowNote className="text-foreground">
        <GitBranchIcon aria-hidden size={14} className={rowIcon} />
        <Tip
          label={`${branch} → ${checkout.baseBranch}, ${checkout.ahead} ahead${checkout.behind ? `, ${checkout.behind} behind` : ""}${base?.note ? ` · ${base.text}. ${base.note}` : ""}`}
        >
          <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
        </Tip>
        {(checkout.ahead > 0 || checkout.behind > 0) && (
          <span className="shrink-0 text-2xs text-subtle-foreground">
            {checkout.ahead > 0 && `↑${checkout.ahead}`}
            {checkout.ahead > 0 && checkout.behind > 0 && " "}
            {checkout.behind > 0 && `↓${checkout.behind}`}
          </span>
        )}
      </RowNote>
      <div className="flex h-7 min-w-0 items-center">
        {checkout.changed > 0 ? (
          <RowButton
            aria-label={`Changes, ${checkout.changed} files: ${checkout.additions} added, ${checkout.deletions} removed`}
            className="flex-1 gap-1.5"
            onClick={() => {
              workspace.open({ kind: "changes" });
              props.onClose();
            }}
          >
            <GitDiffIcon aria-hidden size={14} className={rowIcon} />
            <span className="min-w-0 truncate whitespace-nowrap">
              <DiffStat additions={checkout.additions} deletions={checkout.deletions} />{" "}
              <span className="text-2xs text-subtle-foreground">
                · {checkout.changed} {checkout.changed === 1 ? "file" : "files"}
              </span>
            </span>
          </RowButton>
        ) : (
          <RowNote className="flex-1">
            <GitDiffIcon aria-hidden size={14} className={rowIcon} />
            <span className="min-w-0 truncate">
              {checkout.ahead > 0 ? `${checkout.ahead} to push` : "Up to date"}
            </span>
          </RowNote>
        )}
        {checkout.changed > 0 ? (
          <button
            type="button"
            className={stepButton}
            disabled={git.pending}
            onClick={() => git.open("commit")}
          >
            Commit
          </button>
        ) : create ? (
          <button
            type="button"
            className={stepButton}
            disabled={git.pending}
            onClick={() => git.open("pr")}
          >
            Create PR
          </button>
        ) : null}
        <GitMenu git={git} checkout={checkout} />
      </div>
    </section>
  );
}

const stepButton =
  "focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-secondary px-1.5 text-2xs font-medium hover:bg-accent disabled:text-muted-foreground";

function GitMenu(props: { git: GitFlow; checkout: Checkout }) {
  const { git, checkout } = props;
  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Git actions" size="sm" />} />
      <MenuContent align="end" className="w-[240px]">
        {checkout.changed > 0 && (
          <MenuItem
            icon={glyph(GitCommitIcon)}
            disabled={git.pending}
            onClick={() => git.open("commit-push")}
          >
            Commit &amp; push…
          </MenuItem>
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
      </MenuContent>
    </Menu>
  );
}
