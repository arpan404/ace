import { useThreadMeta } from "@ace/client-react";
import { baseRecordText, checkoutNote, nextGitStep, type Checkout } from "@ace/ui-core";
import {
  CaretDownIcon,
  CloudArrowUpIcon,
  DownloadSimpleIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  LinkSimpleIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Move } from "./checkout-move.tsx";
import type { useGitFlow } from "./use-git-flow.tsx";
import { BranchItems } from "./work-card-branches.tsx";
import { Group, RowButton, RowCaret, RowLabel, RowStatic, rowIcon } from "./work-card-parts.tsx";
import { PrLine } from "./work-card-pr.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/** The branch, its changes, the next git step, its pull request and how it stands. */
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
    <Group id="git" title="Git">
      <BranchRow thread={props.thread} git={git} move={props.move} />
      {checkout && (
        <>
          <RowButton
            aria-label={`Changes, ${checkout.changed} files: ${checkout.additions} added, ${checkout.deletions} removed`}
            onClick={() => {
              workspace.open({ kind: "changes" });
              props.onClose();
            }}
          >
            <GitDiffIcon aria-hidden size={16} className={rowIcon} />
            <RowLabel>Changes</RowLabel>
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
          <GitAction git={git} checkout={checkout} />
          <PrLine git={git} workspaceId={props.thread.workspaceId} onClose={props.onClose} />
          {note && (
            <output className="mx-1 my-0.5 flex h-[26px] items-center gap-2 rounded-sm bg-accent/60 px-2 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-needs-you" />
              {note}
            </output>
          )}
        </>
      )}
    </Group>
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

/**
 * One adaptive git action: the next step (Commit & push, Push, Create PR) as the primary, and
 * every step behind its chevron.
 */
function GitAction(props: { git: GitFlow; checkout: Checkout }) {
  const { git, checkout } = props;
  const step = nextGitStep(checkout);
  const primary =
    step.kind === "commit"
      ? { label: "Commit & push", icon: CloudArrowUpIcon, run: () => git.open("commit-push") }
      : step.kind === "push"
        ? { label: "Push", icon: UploadSimpleIcon, run: git.push }
        : step.kind === "create-pr"
          ? {
              label: "Create PR",
              icon: GitPullRequestIcon,
              run: () => git.open("pr"),
              blocked: step.blocked,
            }
          : { label: "Up to date", icon: CloudArrowUpIcon, blocked: "Nothing to commit or push" };
  const Icon = primary.icon;
  const blocked = "blocked" in primary ? primary.blocked : undefined;
  return (
    <div className="group/split flex h-8 items-center rounded-md transition-colors duration-(--dur-1) hover:bg-accent">
      <button
        type="button"
        className="focus-ring-inset flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2.5 text-left text-ui text-foreground disabled:text-muted-foreground"
        disabled={git.pending || !!blocked || !("run" in primary)}
        title={blocked}
        onClick={"run" in primary ? primary.run : undefined}
      >
        <Icon aria-hidden size={16} className={rowIcon} />
        <RowLabel>{primary.label}</RowLabel>
        {git.pending && <Spinner />}
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="More git actions"
              title="Commit, push, pull, create PR"
              disabled={git.pending}
              className="focus-ring-inset grid size-8 shrink-0 place-items-center rounded-r-md text-muted-foreground hover:text-foreground"
            >
              <CaretDownIcon aria-hidden size={14} />
            </button>
          }
        />
        <MenuContent align="end" className="w-[240px]">
          <GitMenuItems git={git} checkout={checkout} />
        </MenuContent>
      </Menu>
    </div>
  );
}

function GitMenuItems(props: { git: GitFlow; checkout: Checkout }) {
  const { git, checkout } = props;
  const pr = checkout.pr;
  const live = pr?.state === "open" || pr?.state === "draft";
  const nothing = checkout.changed === 0 ? "No changes to commit" : undefined;
  return (
    <>
      <MenuItem
        icon={glyph(GitCommitIcon)}
        disabled={git.pending || !!nothing}
        reason={nothing}
        onClick={() => git.open("commit")}
      >
        Commit…
      </MenuItem>
      <MenuItem
        icon={glyph(CloudArrowUpIcon)}
        disabled={git.pending || !!nothing}
        onClick={() => git.open("commit-push")}
      >
        Commit &amp; push…
      </MenuItem>
      <MenuItem
        icon={glyph(UploadSimpleIcon)}
        disabled={!checkout.branch || git.pending}
        reason={checkout.branch ? undefined : "The checkout is on a detached HEAD"}
        onClick={git.push}
      >
        Push
      </MenuItem>
      <MenuItem
        icon={glyph(DownloadSimpleIcon)}
        disabled
        reason={
          checkout.behind > 0
            ? `${checkout.behind} to pull: run git pull in a terminal for now`
            : "ace can't pull yet: run git pull in a terminal"
        }
      >
        Pull
      </MenuItem>
      <MenuSeparator />
      {!live && (
        <>
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
            onClick={() => git.open("draft-pr")}
          >
            Create draft PR…
          </MenuItem>
        </>
      )}
      {checkout.repository?.forge !== "gitlab" && (
        <MenuItem
          icon={glyph(LinkSimpleIcon)}
          disabled={!!git.linkBlocked || git.pending}
          reason={git.linkBlocked}
          onClick={() => git.open("link-pr")}
        >
          Link a pull request…
        </MenuItem>
      )}
      {pr && (
        <MenuItem
          disabled={git.pending}
          onClick={() =>
            git.run({ kind: "unlink-pr", number: pr.number, ...(pr.repo ? { repo: pr.repo } : {}) })
          }
        >
          Unlink PR #{pr.number}
        </MenuItem>
      )}
    </>
  );
}
