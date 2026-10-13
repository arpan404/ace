import { useThreadMeta } from "@ace/client-react";
import { mergeMethods, nextGitStep, type Checkout } from "@ace/ui-core";
import {
  CaretDownIcon,
  CloudArrowUpIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkSimpleIcon,
  UserPlusIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useMergeMethod } from "./merge-method.ts";
import { useGitFlow } from "./use-git-flow.tsx";
import { useMergePr } from "./work-card-pr.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const glyph = (Glyph: typeof GitCommitIcon) => <Glyph aria-hidden size={16} />;

/** The next git step as one primary action: Commit & push, Push or Create PR. */
function primaryStep(git: GitFlow, checkout: Checkout) {
  const step = nextGitStep(checkout);
  if (step.kind === "commit")
    return { label: "Commit & push", icon: CloudArrowUpIcon, run: () => git.open("commit-push") };
  if (step.kind === "push") return { label: "Push", icon: UploadSimpleIcon, run: git.push };
  if (step.kind === "create-pr")
    return {
      label: "Create PR",
      icon: GitPullRequestIcon,
      run: () => git.open("pr"),
      blocked: step.blocked,
    };
  return { label: "Up to date", icon: CloudArrowUpIcon, blocked: "Nothing to commit or push" };
}

/**
 * One adaptive git action: the next step (Commit & push, Push, Create PR) as the primary, and
 * every step behind its chevron. The thread details card and the Changes header both draw it,
 * so the two never offer different next steps.
 */
export function GitAction(props: {
  git: GitFlow;
  checkout: Checkout;
  className?: string | undefined;
}) {
  const { git, checkout } = props;
  const primary = primaryStep(git, checkout);
  const Icon = primary.icon;
  const blocked = "blocked" in primary ? primary.blocked : undefined;
  return (
    <div
      className={cn(
        "group/split flex h-8 items-center rounded-md transition-colors duration-(--motion-fast) hover:bg-accent",
        props.className,
      )}
    >
      <button
        type="button"
        className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2.5 text-left text-ui text-foreground disabled:text-muted-foreground"
        disabled={git.pending || !!blocked || !("run" in primary)}
        title={blocked}
        onClick={"run" in primary ? primary.run : undefined}
      >
        <Icon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{primary.label}</span>
        {git.pending && <Spinner />}
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="More git actions"
              title="Commit, push, create PR"
              disabled={git.pending}
              className="focus-ring-inset grid h-full w-8 shrink-0 place-items-center rounded-r-md text-muted-foreground hover:text-foreground"
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

/**
 * The thread's git action on its own, for surfaces outside the details card (the Changes
 * header): it reads the checkout and renders the forms it opens. Nothing until the checkout is
 * read, and nothing outside a git checkout.
 */
export function ThreadGitAction(props: { threadId: string; className?: string | undefined }) {
  const meta = useThreadMeta(props.threadId);
  if (!meta) return null;
  return (
    <LoadedGitAction
      thread={{
        id: props.threadId,
        workspaceId: meta.workspaceId,
        title: meta.title,
        provider: meta.provider,
      }}
      className={props.className}
    />
  );
}

function LoadedGitAction(props: {
  thread: Parameters<typeof useGitFlow>[0];
  className: string | undefined;
}) {
  const git = useGitFlow(props.thread);
  if (!git.checkout) return git.dialog;
  return (
    <>
      <GitAction git={git} checkout={git.checkout} className={props.className} />
      {git.dialog}
    </>
  );
}

/**
 * An open PR's actions: merge by any of the forge's methods (the one picked becomes Merge's
 * default) and ask for a review.
 */
function PrMenuItems(props: { git: GitFlow; draft: boolean }) {
  const { git } = props;
  const current = useMergeMethod();
  const { merge, checking } = useMergePr(git);
  const blocked = props.draft ? "Mark this PR ready on GitHub before merging" : undefined;
  return (
    <>
      {mergeMethods.map((each) => (
        <MenuItem
          key={each.method}
          icon={glyph(GitMergeIcon)}
          disabled={git.pending || checking || !!blocked}
          reason={each.method === current ? blocked : undefined}
          onClick={() => void merge(each.method)}
        >
          {each.label}
          {each.method === current && (
            <span className="ml-auto pl-3 text-xs text-subtle-foreground">default</span>
          )}
        </MenuItem>
      ))}
      <MenuItem
        icon={glyph(UserPlusIcon)}
        disabled={git.pending}
        onClick={() => git.open("request-review")}
      >
        Request review…
      </MenuItem>
      <MenuSeparator />
    </>
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
      {live && pr && <PrMenuItems git={git} draft={pr.state === "draft"} />}
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
