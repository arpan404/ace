import { useNavigate } from "@tanstack/react-router";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import { PullRequestGlyph, pullRequestTone as prTone } from "@/components/pull-request-state.tsx";
import type { ForgePrStatus } from "@ace/protocol";
import { prOverview, pullRequestUrl, type CheckoutPr } from "@ace/ui-core";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  DotsThreeIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger, MenuItem } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failure, type useGitFlow } from "./use-git-flow.tsx";
import { PrLinkForm } from "./pr-link-form.tsx";
import { PrDetails } from "./work-card-pr-details.tsx";
import { openPullRequestLink as open } from "./work-card-pr-link.ts";
import { TruncatedText, RowButton, RowNote } from "./work-card-parts.tsx";
import { useWorkCardState } from "./work-card-state.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const prState: Record<CheckoutPr["state"], string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** Compact links; the validated field appears only when requested. */
export function PullRequestsSection(props: {
  git: GitFlow;
  workspaceId: string;
  linking: boolean;
  onLinkClose(): void;
}) {
  const { git } = props;
  const checkout = git.checkout;

  const [confirm, setConfirm] = useState(false);
  const { state, update } = useWorkCardState();
  const expanded = state.sections["pull-requests"] ?? false;
  const links = git.linkedPrs?.length ? git.linkedPrs : checkout?.pr ? [checkout.pr] : [];
  return (
    <section aria-label="Pull requests">
      {(expanded ? links : links.slice(0, 1)).map((pr) => (
        <PrDisclosure
          key={`${pr.repo?.host}/${pr.repo?.owner}/${pr.repo?.name}/${pr.number}`}
          git={git}
          workspaceId={props.workspaceId}
          pr={pr}
          base={checkout?.baseBranch ?? "main"}
          onUnlinkAll={() => setConfirm(true)}
        />
      ))}
      {links.length > 1 && (
        <RowButton
          className="text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => update({ sections: { "pull-requests": !expanded } })}
        >
          <PlusIcon aria-hidden size={16} />
          {expanded ? "Show fewer pull requests" : `Show ${links.length - 1} more`}
        </RowButton>
      )}
      {props.linking && checkout?.repository?.forge !== "gitlab" && (
        <PrLinkForm
          repository={checkout?.repository}
          pending={git.pending}
          onDone={props.onLinkClose}
          onLink={(number, repository) =>
            git.submit({ kind: "link-pr", number, ...(repository ? { repository } : {}) })
          }
        />
      )}
      {confirm && (
        <PrUnlinkDialog
          onClose={() => setConfirm(false)}
          onUnlink={() => git.submit({ kind: "unlink-pr", all: true })}
        />
      )}
    </section>
  );
}

function PrDisclosure(props: {
  workspaceId: string;
  git: GitFlow;
  pr: CheckoutPr;
  base: string;
  onUnlinkAll(): void;
}) {
  const { git, pr } = props;
  const navigate = useNavigate();
  const id = useId();
  const primary = !git.linkedPrs?.length || git.linkedPrs[0] === pr;
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [openNow, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const [checked, setChecked] = useState<ForgePrStatus>();
  const repository = pr.repo ?? git.checkout?.repository;
  const url = pr.url ?? (repository && pullRequestUrl(repository, pr.number));
  const refresh = () => {
    setRefreshing(true);
    git
      .refreshPr(repository ? { repository, number: pr.number } : undefined)
      .then(
        (status) => {
          setChecked(status);
          setError(undefined);
          return status;
        },
        (reason: unknown) => setError(reason ?? "failed"),
      )
      .finally(() => setRefreshing(false));
  };
  const current = checked ?? (primary ? git.status : undefined);
  const merge = async () => {
    if (!repository || refreshing || git.pending) return;
    setRefreshing(true);
    try {
      const status = await git.refreshPr({ repository, number: pr.number });
      if (!status) throw new Error("Couldn't read the pull request");
      setChecked(status);
      setError(undefined);
      const blocked = prOverview(status, props.base).mergeBlocked;
      if (blocked) {
        setOpen(true);
        toast.error({ title: blocked });
        return;
      }
      git.run({
        kind: "merge",
        method: "squash",
        auto: false,
        headSha: status.headSha,
        pr: status.ref,
      });
    } catch (reason) {
      setError(reason);
      setOpen(true);
    } finally {
      setRefreshing(false);
    }
  };
  const title = pr.title ?? current?.title ?? `Pull request #${pr.number}`;
  const state = error !== undefined ? "Unavailable" : refreshing ? "Checking…" : prState[pr.state];
  const ci = error === undefined && !refreshing && pr.ci && pr.ci !== "unknown" ? pr.ci : undefined;
  return (
    <div>
      <div className="group/pr relative flex min-h-(--row-height) min-w-0 items-center">
        <RowButton
          className="flex-1"
          aria-expanded={openNow}
          aria-controls={id}
          onClick={() => {
            setOpen(!openNow);
            if (!openNow) refresh();
          }}
          aria-label={`Pull request #${pr.number}${title ? `: ${title}` : ""}, ${state}${ci && ci !== "none" ? `, checks ${ci === "success" ? "passed" : ci === "failure" ? "failing" : "running"}` : ""}`}
        >
          <PullRequestGlyph state={pr.state} size={14} />
          <Tip label={title}>
            <TruncatedText>{title}</TruncatedText>
          </Tip>
        </RowButton>
        {url && (
          <IconButton
            icon={ArrowSquareOutIcon}
            label={`Open PR #${pr.number} on GitHub`}
            size="sm"
            onClick={() => open(url, () => toast.error({ title: "Couldn’t open the PR" }))}
          />
        )}
        <span className="absolute right-6 hidden bg-panel group-focus-within/pr:inline-flex group-hover/pr:inline-flex [@media(pointer:coarse)]:inline-flex">
          <Menu>
            <MenuTrigger
              render={
                <IconButton icon={DotsThreeIcon} label={`PR #${pr.number} actions`} size="sm" />
              }
            />
            <MenuContent align="end">
              {repository && (
                <MenuItem
                  onClick={() =>
                    void navigate({
                      to: "/pull-requests",
                      search: {
                        project: props.workspaceId,
                        repo: `${repository.host}/${repository.owner}/${repository.name}`,
                        number: pr.number,
                      },
                    })
                  }
                >
                  Open full PR workspace
                </MenuItem>
              )}
              <MenuItem
                disabled={git.pending}
                onClick={() =>
                  git.run({
                    kind: "unlink-pr",
                    number: pr.number,
                    ...(pr.repo ? { repo: pr.repo } : {}),
                  })
                }
              >
                Unlink PR #{pr.number}
              </MenuItem>
              <MenuItem onClick={props.onUnlinkAll}>Unlink all</MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </div>
      <div className="flex min-h-(--control-height) items-center justify-between gap-2 pl-8 pr-2 text-xs">
        <span className={prTone(pr.state)}>
          #{pr.number} · {state}
        </span>
        {(pr.state === "open" || pr.state === "draft") && (
          <button
            type="button"
            className="focus-ring touch-hit rounded-sm text-link hover:underline disabled:text-muted-foreground"
            disabled={git.pending || refreshing || pr.state === "draft" || !repository}
            aria-label={`Merge PR #${pr.number}`}
            title={
              pr.state === "draft"
                ? "Mark this PR ready on GitHub before merging"
                : "Review and confirm merge"
            }
            onClick={() => void merge()}
          >
            {refreshing ? "Checking…" : "Merge"}
          </button>
        )}
      </div>
      {openNow && (
        <section id={id} aria-label={`Pull request #${pr.number}`}>
          <div className="flex min-h-(--row-height) items-center gap-1 pr-1 pl-2.5">
            <Tip label={title}>
              <h3 className="min-w-0 flex-1 truncate text-ui">
                <span className="text-subtle-foreground">#{pr.number}</span> {pr.title}
              </h3>
            </Tip>
            {refreshing ? (
              <Spinner label="Reading the pull request" className="mx-1.5" />
            ) : (
              <IconButton
                icon={ArrowClockwiseIcon}
                label="Refresh"
                size="sm"
                className="size-7"
                onClick={refresh}
              />
            )}
          </div>
          {error !== undefined ? (
            <>
              <p role="alert" className="px-2.5 py-1 text-sm text-status-failed">
                {failure(error)}
              </p>
            </>
          ) : current && current.ref.number === pr.number ? (
            <PrDetails
              git={git}
              status={current}
              base={props.base}
              onRequestReview={
                primary
                  ? () => {
                      setOpen(false);
                      git.open("request-review");
                    }
                  : undefined
              }
            />
          ) : (
            <RowNote>
              {refreshing ? "Reading the pull request…" : "No status from GitHub yet"}
            </RowNote>
          )}
        </section>
      )}
    </div>
  );
}
