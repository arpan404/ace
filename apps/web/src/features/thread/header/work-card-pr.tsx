import type { ForgeCheck, ForgePrStatus } from "@ace/protocol";
import {
  mergeMethods,
  prOverview,
  pullRequestUrl,
  type CheckoutPr,
  type MergeMethod,
  type PrTone,
} from "@ace/ui-core";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MinusCircleIcon,
  UserPlusIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failure, type useGitFlow } from "./use-git-flow.tsx";
import { Fade, RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const prState: Record<CheckoutPr["state"], string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** A CI or check state as a glyph in its status colour. */
const tones: Record<PrTone | ForgeCheck["status"], { glyph: typeof ClockIcon; tone: string }> = {
  success: { glyph: CheckCircleIcon, tone: "text-status-done" },
  failure: { glyph: XCircleIcon, tone: "text-status-failed" },
  pending: { glyph: ClockIcon, tone: rowIcon },
  none: { glyph: MinusCircleIcon, tone: rowIcon },
  cancelled: { glyph: MinusCircleIcon, tone: rowIcon },
  unknown: { glyph: MinusCircleIcon, tone: rowIcon },
};
function ToneIcon(props: { tone: keyof typeof tones }) {
  const { glyph: Glyph, tone } = tones[props.tone];
  return <Glyph aria-hidden size={16} className={`shrink-0 ${tone}`} />;
}

const open = (url: string, onError: () => void) => void openExternal(url).catch(onError);

/**
 * The thread's pull request: a row that opens its popover (checks, conflicts, open review
 * threads, Merge and Request review), or why there is none. GitLab is named up front: the daemon
 * can't open or follow merge requests yet.
 */
export function PullRequestsSection(props: { git: GitFlow }) {
  const { checkout } = props.git;
  const pr = checkout?.pr;
  return (
    <section aria-labelledby="work-card-prs">
      <SectionHead id="work-card-prs" title="Pull requests" />
      {pr && checkout ? (
        <PrPopover git={props.git} pr={pr} base={checkout.baseBranch} />
      ) : (
        <RowNote>
          <GitPullRequestIcon aria-hidden size={16} className={rowIcon} />
          {!checkout
            ? "No branch to open one from"
            : checkout.repository?.forge === "gitlab"
              ? "GitLab merge requests aren't supported yet"
              : "None for this branch yet"}
        </RowNote>
      )}
    </section>
  );
}

function PrPopover(props: { git: GitFlow; pr: CheckoutPr; base: string }) {
  const { git, pr } = props;
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [openNow, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const repository = git.checkout?.repository;
  const url = pr.url ?? (repository && pullRequestUrl(repository, pr.number));
  const refresh = () => {
    setRefreshing(true);
    git
      .refreshPr()
      .then(
        () => setError(undefined),
        (reason: unknown) => setError(reason ?? "failed"),
      )
      .finally(() => setRefreshing(false));
  };
  const ci = pr.ci && pr.ci !== "unknown" ? pr.ci : undefined;
  return (
    <Popover
      open={openNow}
      onOpenChange={(next) => {
        setOpen(next);
        // Opening asks the forge again: checks and mergeability move while nobody looks.
        if (next) refresh();
      }}
    >
      <PopoverTrigger
        render={
          <RowButton
            aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${prState[pr.state]}${ci && ci !== "none" ? `, checks ${ci === "success" ? "passed" : ci === "failure" ? "failing" : "running"}` : ""}`}
            className="aria-expanded:bg-accent"
          />
        }
      >
        <GitPullRequestIcon aria-hidden size={16} className={rowIcon} />
        <Fade>
          <span className="text-subtle-foreground">#{pr.number}</span>{" "}
          {pr.title ?? git.checkout?.branch}
        </Fade>
        <span className="shrink-0 text-xs text-subtle-foreground">{prState[pr.state]}</span>
        {ci && ci !== "none" && <ToneIcon tone={ci} />}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`Pull request #${pr.number}`}
        className="max-h-[min(360px,var(--available-height))] w-[340px] overflow-y-auto p-1.5"
      >
        <div className="flex h-8 items-center gap-1 pr-1 pl-2.5">
          <h3 className="min-w-0 flex-1 truncate text-ui">
            <span className="text-subtle-foreground">#{pr.number}</span> {pr.title}
          </h3>
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
          {url && (
            <IconButton
              icon={ArrowSquareOutIcon}
              label="Open on GitHub"
              size="sm"
              className="size-7"
              onClick={() => open(url, () => toast.error({ title: "Couldn't open the PR" }))}
            />
          )}
        </div>
        {error !== undefined && (
          <p role="alert" className="px-2.5 pb-1 text-sm text-status-failed">
            {failure(error)}
          </p>
        )}
        {git.status ? (
          <PrDetails
            git={git}
            status={git.status}
            base={props.base}
            onRequestReview={() => {
              setOpen(false);
              git.open("request-review");
            }}
          />
        ) : (
          <RowNote>
            {refreshing ? "Reading the pull request…" : "No status from GitHub yet"}
          </RowNote>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PrDetails(props: {
  git: GitFlow;
  status: ForgePrStatus;
  base: string;
  onRequestReview(): void;
}) {
  const { git, status } = props;
  const toast = useToast();
  const view = prOverview(status, props.base);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const label = mergeMethods.find((each) => each.method === method)?.label ?? "Merge";
  const settled = status.state === "merged" || status.state === "closed";
  return (
    <>
      <RowNote className="text-foreground">
        <ToneIcon tone={view.ci.tone} />
        {view.ci.text}
      </RowNote>
      {view.checks.length > 0 && (
        <ul aria-label="Checks">
          {view.checks.map((check) => (
            <li key={check.id} className="flex h-7 items-center gap-2.5 pr-1 pl-6 text-sm">
              <ToneIcon tone={check.status} />
              <Fade>{check.name}</Fade>
              {check.url && (
                <IconButton
                  icon={ArrowSquareOutIcon}
                  label={`Open the ${check.name} logs`}
                  size="sm"
                  onClick={() =>
                    check.url &&
                    open(check.url, () => toast.error({ title: "Couldn't open the logs" }))
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!settled && (
        <RowNote className="text-foreground">
          {view.merge.tone === "conflict" ? (
            <WarningIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
          ) : (
            <GitMergeIcon aria-hidden size={16} className={rowIcon} />
          )}
          {view.merge.text}
        </RowNote>
      )}
      <RowNote className={view.unresolved ? "text-foreground" : undefined}>
        <ChatsCircleIcon aria-hidden size={16} className={rowIcon} />
        {view.unresolved
          ? `${view.unresolved} unresolved review ${view.unresolved === 1 ? "thread" : "threads"}`
          : "No unresolved review threads"}
      </RowNote>
      {!settled && (
        <div className="flex h-10 items-center gap-2 pr-1 pl-2.5">
          <SplitButton
            label={label}
            actionLabel={view.mergeBlocked ?? `${label} into ${props.base}`}
            actionDisabled={!!view.mergeBlocked}
            className={view.mergeBlocked ? "text-muted-foreground" : ""}
            menuLabel="Merge options"
            disabled={git.pending}
            onAction={() =>
              git.run({ kind: "merge", method, auto: false, headSha: status.headSha })
            }
            menu={
              <>
                <MenuRadioGroup
                  value={method}
                  onValueChange={(value: MergeMethod) => setMethod(value)}
                >
                  {mergeMethods.map((each) => (
                    <MenuRadioItem key={each.method} value={each.method}>
                      {each.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem
                  icon={<ClockIcon aria-hidden size={16} />}
                  disabled={!!view.autoMergeBlocked}
                  reason={view.autoMergeBlocked}
                  onClick={() =>
                    git.run({ kind: "merge", method, auto: true, headSha: status.headSha })
                  }
                >
                  Auto-merge when checks pass
                </MenuItem>
              </>
            }
          />
          <span className="min-w-0 flex-1 truncate text-sm text-subtle-foreground">
            {git.pending ? <Spinner label="Working on it" /> : view.mergeBlocked}
          </span>
          <IconButton
            icon={UserPlusIcon}
            label="Request review…"
            size="sm"
            className="size-7"
            disabled={git.pending}
            onClick={props.onRequestReview}
          />
        </div>
      )}
    </>
  );
}
