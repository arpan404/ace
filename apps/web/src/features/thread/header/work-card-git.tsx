import { nextGitStep, pullRequestUrl, type Checkout, type CheckoutPr } from "@ace/ui-core";
import {
  DotsThreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  PaperPlaneTiltIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { openExternal } from "@/boot/open-external.ts";
import { DiffStat } from "@/components/diff-stat.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useThreadDiffStat } from "@/lib/diffs/use-turns.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { useGitFlow } from "./use-git-flow.tsx";
import { Fade, RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/**
 * Changes (the thread's own edits, opening the Changes tab), then the branch the checkout is on
 * with the next git step (Commit & push, Push, Create PR) and every git action behind its ⋯.
 */
export function ChangesSection(props: { thread: ThreadRef; git: GitFlow; onClose(): void }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const stat = useThreadDiffStat(props.thread.id);
  const edited = stat.additions + stat.deletions > 0;
  return (
    <section aria-label="Changes and branch">
      <RowButton
        aria-label={`Changes: ${edited ? `${stat.additions} added, ${stat.deletions} removed` : "no edits yet"}`}
        onClick={() => {
          workspace.open({ kind: "changes" });
          props.onClose();
        }}
      >
        <GitDiffIcon aria-hidden size={16} className={rowIcon} />
        <span className="min-w-0 flex-1 truncate">Changes</span>
        {edited ? (
          <DiffStat {...stat} className="text-xs" />
        ) : (
          <span className="text-xs text-subtle-foreground">No edits yet</span>
        )}
      </RowButton>
      <BranchRow git={props.git} onClose={props.onClose} />
    </section>
  );
}

const shortSha = (head: string | null) => head?.slice(0, 7);

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
  const sha = shortSha(checkout.head);
  const status =
    checkout.changed > 0
      ? `${checkout.changed} uncommitted`
      : checkout.ahead > 0
        ? `${checkout.ahead} to push`
        : undefined;
  return (
    <div className="flex h-8 items-center gap-2.5 pr-1 pl-2.5 text-ui">
      <GitBranchIcon aria-hidden size={16} className={rowIcon} />
      <Fade>
        <span>{branch}</span>
        {sha && <span className="font-mono text-xs text-subtle-foreground"> {sha}</span>}
        {status && <span className="text-subtle-foreground"> · {status}</span>}
      </Fade>
      <NextStep git={git} checkout={checkout} />
      <GitMenu git={git} checkout={checkout} />
    </div>
  );
}

/** The next git step: a quiet pill, so it reads as the row's one action. */
const stepButton =
  "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-foreground/6 px-2.5 text-sm font-medium text-foreground transition-colors duration-(--dur-1) hover:bg-foreground/10 disabled:text-muted-foreground aria-disabled:text-muted-foreground aria-disabled:hover:bg-foreground/6";

/** The one git step that moves the branch on: commit (and push), push, or open a PR. */
function NextStep(props: { git: GitFlow; checkout: Checkout }) {
  const { git } = props;
  const step = nextGitStep(props.checkout);
  if (step.kind === "pr") return null;
  if (step.kind === "commit")
    return (
      <button
        type="button"
        className={stepButton}
        disabled={git.pending}
        onClick={() => git.open("commit-push")}
      >
        Commit &amp; push
      </button>
    );
  if (step.kind === "push")
    return (
      <button type="button" className={stepButton} disabled={git.pending} onClick={git.push}>
        Push
      </button>
    );
  return (
    <Tip label={step.blocked ?? "Open a pull request for this branch"}>
      <button
        type="button"
        className={stepButton}
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
  const nothing = checkout.changed === 0 ? "Nothing uncommitted" : undefined;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton icon={DotsThreeIcon} label="Git actions" size="sm" className="size-7" />
        }
      />
      <MenuContent align="end" className="w-[240px]">
        <MenuItem
          icon={glyph(GitCommitIcon)}
          disabled={!!nothing || git.pending}
          reason={nothing}
          onClick={() => git.open("commit")}
        >
          Commit…
        </MenuItem>
        <MenuItem
          icon={glyph(PaperPlaneTiltIcon)}
          disabled={!!nothing || git.pending}
          reason={nothing}
          onClick={() => git.open("commit-push")}
        >
          Commit &amp; push…
        </MenuItem>
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
      </MenuContent>
    </Menu>
  );
}

const prState: Record<CheckoutPr["state"], string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** The branch's pull request (the one the daemon linked to this thread), opening on its forge. */
export function PullRequestsSection(props: { git: GitFlow; onClose(): void }) {
  const toast = useToast();
  const checkout = props.git.checkout;
  const pr = checkout?.pr;
  const url =
    pr && (pr.url ?? (checkout.repository && pullRequestUrl(checkout.repository, pr.number)));
  return (
    <section aria-labelledby="work-card-prs">
      <SectionHead id="work-card-prs" title="Pull requests" />
      {pr ? (
        <RowButton
          aria-label={`Open pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${prState[pr.state]}`}
          disabled={!url}
          onClick={() => {
            if (!url) return;
            void openExternal(url).catch(() => toast.error({ title: "Couldn't open the PR" }));
            props.onClose();
          }}
        >
          <GitPullRequestIcon aria-hidden size={16} className={rowIcon} />
          <Fade>
            <span className="text-subtle-foreground">#{pr.number}</span>{" "}
            {pr.title ?? checkout.branch}
          </Fade>
          <span className="shrink-0 text-xs text-subtle-foreground">{prState[pr.state]}</span>
        </RowButton>
      ) : (
        <RowNote>
          <GitPullRequestIcon aria-hidden size={16} className={rowIcon} />
          {checkout ? "None for this branch yet" : "No branch to open one from"}
        </RowNote>
      )}
    </section>
  );
}
