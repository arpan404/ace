import { PullRequestGlyph, pullRequestTone as prTone } from "@/components/pull-request-state.tsx";
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
  LinkBreakIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuTrigger,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failure, type useGitFlow } from "./use-git-flow.tsx";
import { PrLinkForm } from "./pr-link-form.tsx";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import { TruncatedText, RowButton, RowNote, rowIcon, WorkSection } from "./work-card-parts.tsx";

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

/** Linked PR rows and an inline field, with details for the primary link. */
export function PullRequestsSection(props: { git: GitFlow }) {
  const { checkout } = props.git;
  const pr = checkout?.pr;
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const links = props.git.linkedPrs;
  return (
    <WorkSection
      id="work-card-prs"
      title="Pull requests"
      controls={
        (pr || !!links?.length) && (
          <Menu>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="Pull request actions" size="sm" />}
            />
            <MenuContent align="end">
              <MenuItem onClick={() => setConfirm(true)}>Unlink all</MenuItem>
            </MenuContent>
          </Menu>
        )
      }
    >
      {pr && checkout ? (
        <>
          <PrDisclosure key={pr.number} git={props.git} pr={pr} base={checkout.baseBranch} />
        </>
      ) : !links?.length ? (
        <RowNote>
          <GitPullRequestIcon aria-hidden size={16} className={rowIcon} />
          {!checkout
            ? "No branch to open one from"
            : checkout.repository?.forge === "gitlab"
              ? "GitLab merge requests aren't supported yet"
              : "None for this branch yet"}
        </RowNote>
      ) : null}
      {(pr && checkout ? links?.slice(1) : links)?.map((link) => (
        <div
          key={`${link.repo.host}/${link.repo.owner}/${link.repo.name}/${link.number}`}
          className="flex h-8 min-w-0 items-center gap-2 px-2.5 text-ui"
        >
          <PullRequestGlyph state={link.state} size={16} />
          <Tip label={link.title ?? `Pull request #${link.number}`}>
            <TruncatedText>
              #{link.number} {link.title}
            </TruncatedText>
          </Tip>
          <Tip
            label={
              link.deleted
                ? "This pull request was deleted on GitHub"
                : link.unverified
                  ? "Not checked yet. ace will refresh when GitHub is reachable."
                  : link.state
            }
          >
            <span className={`text-xs ${prTone(link.state)}`}>{link.state}</span>
          </Tip>
          <IconButton
            icon={ArrowSquareOutIcon}
            label={`Open PR #${link.number} on GitHub`}
            size="sm"
            onClick={() => open(link.url, () => toast.error({ title: "Couldn’t open the PR" }))}
          />
          <IconButton
            icon={LinkBreakIcon}
            label={`Unlink PR #${link.number}`}
            size="sm"
            disabled={props.git.pending}
            onClick={() =>
              props.git.run({ kind: "unlink-pr", number: link.number, repo: link.repo })
            }
          />
        </div>
      ))}
      {checkout?.repository?.forge !== "gitlab" && (
        <PrLinkForm
          repository={checkout?.repository}
          pending={props.git.pending}
          onLink={(number, repository) =>
            props.git.submit({ kind: "link-pr", number, ...(repository ? { repository } : {}) })
          }
        />
      )}
      {confirm && (
        <PrUnlinkDialog
          onClose={() => setConfirm(false)}
          onUnlink={() => props.git.submit({ kind: "unlink-pr", all: true })}
        />
      )}
    </WorkSection>
  );
}

function PrDisclosure(props: { git: GitFlow; pr: CheckoutPr; base: string }) {
  const { git, pr } = props;
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [openNow, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const repository = pr.repo ?? git.checkout?.repository;
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
  const state = error !== undefined ? "Unavailable" : refreshing ? "Checking…" : prState[pr.state];
  const ci = error === undefined && !refreshing && pr.ci && pr.ci !== "unknown" ? pr.ci : undefined;
  return (
    <div>
      <div className="flex min-w-0 items-center">
        <RowButton
          aria-expanded={openNow}
          aria-controls={`pr-${pr.number}`}
          onClick={() => {
            setOpen(!openNow);
            if (!openNow) refresh();
          }}
          aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${state}${ci && ci !== "none" ? `, checks ${ci === "success" ? "passed" : ci === "failure" ? "failing" : "running"}` : ""}`}
        >
          <PullRequestGlyph state={pr.state} size={16} />
          <Tip label={pr.title ?? git.checkout?.branch}>
            <TruncatedText>
              <span className="text-subtle-foreground">#{pr.number}</span>{" "}
              {pr.title ?? git.checkout?.branch}
            </TruncatedText>
          </Tip>
          <Tip
            label={
              pr.deleted
                ? "This pull request was deleted on GitHub"
                : pr.unverified
                  ? "Not checked yet. ace will refresh when GitHub is reachable."
                  : state
            }
          >
            <span className={`shrink-0 text-xs ${prTone(pr.state)}`}>{state}</span>
          </Tip>
          {ci && ci !== "none" && <ToneIcon tone={ci} />}
        </RowButton>
        {url && (
          <IconButton
            icon={ArrowSquareOutIcon}
            label="Open on GitHub"
            size="sm"
            onClick={() => open(url, () => toast.error({ title: "Couldn’t open the PR" }))}
          />
        )}
        <IconButton
          icon={LinkBreakIcon}
          label={`Unlink PR #${pr.number}`}
          size="sm"
          disabled={git.pending}
          onClick={() =>
            git.run({
              kind: "unlink-pr",
              number: pr.number,
              ...(git.linkedPrs?.[0]?.repo ? { repo: git.linkedPrs[0].repo } : {}),
            })
          }
        />
      </div>
      {openNow && (
        <section id={`pr-${pr.number}`} aria-label={`Pull request #${pr.number}`}>
          <div className="flex h-8 items-center gap-1 pr-1 pl-2.5">
            <Tip label={pr.title ?? `Pull request #${pr.number}`}>
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
          ) : git.status ? (
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
        </section>
      )}
    </div>
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
              <TruncatedText>{check.name}</TruncatedText>
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
