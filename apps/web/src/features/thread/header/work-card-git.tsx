import { nextGitStep, type Checkout } from "@ace/ui-core";
import {
  DotsThreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  LinkIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useScopedDiff } from "@/lib/diffs/use-scoped-diff.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { useGitFlow } from "./use-git-flow.tsx";
import { RowButton, RowNote, rowIcon } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/**
 * Changes (the thread's own edits, opening the Changes tab), then the branch the checkout is on
 * with the next git step (Commit & push, Push, Create PR) and every git action behind its ⋯.
 */
export function ChangesSection(props: { thread: ThreadRef; git: GitFlow; onClose(): void }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const { stat, label, pending } = useScopedDiff(props.thread.id);
  const edited = stat.additions + stat.deletions > 0;
  return (
    <section aria-label="Changes and branch">
      <RowButton
        aria-label={`Changes, ${label.toLowerCase()}: ${edited ? `${stat.additions} added, ${stat.deletions} removed` : pending ? "preparing changes" : "no edits yet"}`}
        onClick={() => {
          workspace.open({ kind: "changes" });
          props.onClose();
        }}
      >
        <GitDiffIcon aria-hidden size={16} className={rowIcon} />
        <span className="min-w-0 flex-1 truncate">Changes · {label}</span>
        {edited ? (
          <DiffStat {...stat} className="text-xs" />
        ) : (
          <span className="text-xs text-subtle-foreground">
            {pending ? "Preparing changes" : "No edits yet"}
          </span>
        )}
      </RowButton>
      <BranchRow git={props.git} onClose={props.onClose} />
    </section>
  );
}

function BranchRow(props: { git: GitFlow; onClose(): void }) {
  const { checkout, state } = props.git;
  // A form steps in front of the card: the card gives way to it.
  const git: GitFlow = {
    ...props.git,
    open: (kind) => {
      props.git.open(kind);
      props.onClose();
    },
  };
  if (!checkout)
    return (
      <RowNote>
        <GitBranchIcon aria-hidden size={16} className={rowIcon} />
        {state === "loading" ? (
          <span className="flex items-center gap-1.5">
            <Spinner /> Reading the checkout
          </span>
        ) : (
          "Not a git checkout"
        )}
      </RowNote>
    );
  const branch = checkout.branch ?? "detached HEAD";
  const status =
    checkout.changed > 0
      ? `${checkout.changed} uncommitted`
      : checkout.ahead > 0
        ? `${checkout.ahead} to push`
        : undefined;
  return (
    <div className="flex h-8 items-center gap-2.5 pr-1 pl-2.5 text-ui">
      <GitBranchIcon aria-hidden size={16} className={rowIcon} />
      <Tip label={`${branch}${status ? ` · ${status}` : ""}`}>
        <span className="min-w-0 flex-1 truncate">{branch}</span>
      </Tip>
      {status && <span className="shrink-0 text-xs text-subtle-foreground">{status}</span>}
      <NextStep git={git} checkout={checkout} />
      <GitMenu git={git} checkout={checkout} />
    </div>
  );
}

/** The branch row's next action. */
const stepButton =
  "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2.5 text-sm font-medium transition-colors duration-(--dur-1) hover:bg-accent disabled:text-muted-foreground";

/** The one git step that moves the branch on: commit (and push), push, or open a PR. */
function NextStep(props: { git: GitFlow; checkout: Checkout }) {
  const { git } = props;
  const step = nextGitStep(props.checkout);
  if (step.kind === "pr") return null;
  if (step.kind === "commit")
    return (
      <button
        type="button"
        className={`${stepButton} text-foreground`}
        disabled={git.pending}
        onClick={() => git.open("commit-push")}
      >
        Commit &amp; push
      </button>
    );
  if (step.kind === "push")
    return (
      <button
        type="button"
        className={`${stepButton} text-foreground`}
        disabled={git.pending}
        onClick={git.push}
      >
        Push
      </button>
    );
  return (
    <Tip label={step.blocked ?? "Open a pull request for this branch"}>
      <button
        type="button"
        className={`${stepButton} ${step.blocked ? "text-muted-foreground" : "text-foreground"}`}
        aria-disabled={step.blocked || git.pending ? true : undefined}
        aria-description={step.blocked}
        onClick={() => !step.blocked && !git.pending && git.open("pr")}
      >
        Create PR
      </button>
    </Tip>
  );
}

function GitMenu(props: { git: GitFlow; checkout: Checkout }) {
  const { git, checkout } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton icon={DotsThreeIcon} label="Git actions" size="sm" className="size-7" />
        }
      />
      <MenuContent align="end" className="w-[240px]">
        <MenuItem
          icon={glyph(UploadSimpleIcon)}
          disabled={!checkout.branch || git.pending}
          reason={checkout.branch ? undefined : "Detached HEAD: no branch to push"}
          onClick={git.push}
        >
          Push
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={glyph(GitPullRequestIcon)}
          disabled={!!git.draftBlocked || git.pending}
          reason={git.draftBlocked}
          onClick={() => git.open("pr")}
        >
          Create PR…
        </MenuItem>
        <MenuItem
          icon={glyph(GitPullRequestIcon)}
          disabled={!!git.draftBlocked || git.pending}
          reason={git.draftBlocked}
          onClick={() => git.open("draft-pr")}
        >
          Create draft PR…
        </MenuItem>
        <MenuItem
          icon={glyph(LinkIcon)}
          disabled={!!git.linkBlocked || git.pending}
          reason={git.linkBlocked}
          onClick={() => git.open("link-pr")}
        >
          Link existing PR…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
