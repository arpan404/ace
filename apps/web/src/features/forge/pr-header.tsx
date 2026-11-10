import { useState, type MouseEvent, type ReactNode } from "react";
import { prWords, type MergeMethod } from "@ace/ui-core";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import {
  ArrowLeftIcon,
  CaretDownIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import type { PrActions } from "./pr-actions.ts";
import { PrPrimaryButton } from "./pr-primary-button.tsx";
import { WorkTitle } from "@/components/work-heading.tsx";
import { PrAgentChip } from "./pr-agent-chip.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";

/** The title, editable in place where GitHub lets this account change it. */
export function PrTitle(props: {
  actions: PrActions;
  condensed: boolean;
  /** On a page of its own: large type with the number, as an issue's page has. */
  page?: boolean | undefined;
}) {
  const { lifecycle, context } = props.actions;
  const title = context.detail.status.title;
  const [draft, setDraft] = useState<string | undefined>();
  const editable = !!lifecycle.snapshot?.editableFields.includes("title");
  const save = async () => {
    const next = draft?.trim();
    if (!next || next === title) return setDraft(undefined);
    if (await lifecycle.apply({ kind: "edit", changes: { title: next } })) setDraft(undefined);
  };
  if (draft !== undefined)
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label="Title"
          autoFocus
          value={draft}
          maxLength={256}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(undefined);
            }
          }}
          className="h-7 flex-1"
        />
        <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(undefined)}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          variant="primary"
          disabled={lifecycle.blocked || !draft.trim()}
        >
          Save
        </Button>
      </form>
    );
  const edit = editable && !props.condensed && (
    <IconButton
      icon={PencilSimpleIcon}
      label="Edit title"
      size="sm"
      disabled={lifecycle.blocked}
      className="opacity-0 group-focus-within/title:opacity-100 group-hover/title:opacity-100 pointer-coarse:opacity-100"
      onClick={() => setDraft(title)}
    />
  );
  if (props.page)
    return <WorkTitle text={title} number={context.detail.status.ref.number} trailing={edit} />;
  if (props.condensed)
    return (
      <h2 title={title} className="min-w-0 truncate text-ui font-medium">
        {title}
      </h2>
    );
  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      <h2 className="min-w-0 text-lg leading-7 font-semibold tracking-title text-foreground">
        {title} {/* The article around it already names the number. */}
        <span aria-hidden className="font-normal text-subtle-foreground tabular-nums">
          #{context.detail.status.ref.number}
        </span>
      </h2>
      {edit}
    </div>
  );
}

/**
 * The merge method, as a caret beside Merge: only the methods the repository allows, and only
 * when it allows more than one. The choice is kept per project on this device.
 */
function MergeMethodMenu(props: { actions: PrActions; disabled: boolean }) {
  const { actions } = props;
  const kind = actions.primary.kind;
  if (kind !== "merge" && kind !== "auto-merge" && kind !== "auto-merge-ready") return null;
  if (actions.methods.length < 2) return null;
  const current = actions.methods.find((choice) => choice.method === actions.method);
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={CaretDownIcon}
            size="sm"
            label={`Merge method: ${current?.label ?? actions.method}`}
            disabled={props.disabled}
          />
        }
      />
      <MenuContent align="end" className="w-56">
        <MenuGroup>
          <MenuLabel>Merge method</MenuLabel>
          <MenuRadioGroup
            value={actions.method}
            onValueChange={(value: MergeMethod) => actions.setMethod(value)}
          >
            {actions.methods.map((choice) => (
              <MenuRadioItem key={choice.method} value={choice.method}>
                {choice.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * The header's one primary control (merge, auto-merge, resolve…) with the merge method beside
 * it, and turning auto-merge off.
 */
export function PrPrimaryControl(props: {
  actions: PrActions;
  /** Shows what blocks the merge; with it a blocked merge is words, not a dead button. */
  onBlocked?: (() => void) | undefined;
  blockingCount?: number | undefined;
}) {
  const { actions } = props;
  const working = actions.writes.pending || actions.mergeState.pending || actions.lifecycle.pending;
  return (
    <span className="inline-flex items-center gap-0.5">
      <PrPrimaryButton
        primary={actions.primary}
        blocked={actions.primaryBlocked}
        working={working}
        onRun={() => void actions.runPrimary()}
        confirmsItself={actions.editsCommit}
        onBlocked={props.onBlocked}
        blockingCount={props.blockingCount}
        onDisable={() => void actions.mergeState.run("disable", actions.method)}
        disableBlocked={
          actions.mergeState.blocked ??
          (actions.mergeState.state?.canDisable
            ? undefined
            : "GitHub doesn't let this account turn auto-merge off")
        }
      />
      <MergeMethodMenu actions={actions} disabled={working} />
    </span>
  );
}

/** A branch name: mono, in ink, struck through once the branch is deleted. */
function BranchName(props: { name: string; deleted?: boolean | undefined }) {
  return (
    <span
      title={props.name}
      className={cn(
        "inline-block max-w-64 min-w-0 truncate align-middle font-mono text-xs",
        props.deleted ? "text-subtle-foreground line-through" : "text-foreground/90",
      )}
    >
      {props.deleted && <span className="sr-only">deleted branch </span>}
      {props.name}
    </span>
  );
}

/** The state as its glyph and word, in the state's colour, with nothing around it. */
function StateMark(props: { state: "open" | "draft" | "merged" | "closed" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium",
        pullRequestTone(props.state),
      )}
    >
      <PullRequestGlyph state={props.state} size={15} />
      {prWords[props.state]}
    </span>
  );
}

/**
 * Under the title, one line: the state in its colour, then "mira wants to merge 3 commits into
 * main from fix/socket", the checkout command a copy away, and when it was last updated.
 */
export function PrByline(props: { actions: PrActions }) {
  const { detail } = props.actions.context;
  const { status } = detail;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy the checkout command" }),
  );
  const commits = `${detail.commits} ${detail.commits === 1 ? "commit" : "commits"}`;
  const deleted = props.actions.lifecycle.snapshot?.headBranch?.exists === false;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-muted-foreground">
      {status.state !== "unknown" && (
        <>
          <StateMark state={status.state} />
          <span aria-hidden className="text-faint-foreground">
            ·
          </span>
        </>
      )}
      <span className="inline-flex items-center gap-1.5">
        <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
        <span className="font-medium text-foreground/90">{detail.author}</span>
      </span>
      <span>
        {status.state === "merged" ? `merged ${commits} into` : `wants to merge ${commits} into`}
      </span>
      <BranchName name={detail.baseBranch} />
      <span>from</span>
      <BranchName name={detail.headBranch} deleted={deleted} />
      <IconButton
        icon={copied ? CheckIcon : CopyIcon}
        label={copied ? "Checkout command copied" : "Copy checkout command"}
        size="sm"
        onClick={() => copy(checkout)}
      />
      <span aria-hidden className="text-faint-foreground">
        ·
      </span>
      <span className="whitespace-nowrap text-subtle-foreground">
        <PrTime at={detail.updatedAt} prefix="updated " />
      </span>
    </div>
  );
}

/**
 * The PR panel's header, GitHub's way: the repository (opening the PR on GitHub) with the agent,
 * Review, the one primary control and ⋯ on the first line; then the title with its number, and
 * the state's pill with who wants to merge what where. Scrolled, it folds to the first line with
 * the title moved into it, plus a thin branch line.
 */
export function PrHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  condensed: boolean;
  onBack?: (() => void) | undefined;
  /** Takes the person to what blocks the merge. */
  onBlocked?: (() => void) | undefined;
  blockingCount?: number | undefined;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const repository = status.ref.repository;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const openUrl = (url: string, click?: MouseEvent) =>
    void openWeb(url, click).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  return (
    <header className="shrink-0 pt-2">
      <div className="flex h-8 min-w-0 items-center gap-1 px-[var(--forge-gutter,1rem)]">
        {props.onBack && (
          <IconButton
            icon={ArrowLeftIcon}
            label="Back to pull requests"
            onClick={props.onBack}
            size="sm"
          />
        )}
        <button
          type="button"
          onClick={(event) => openUrl(status.url, event)}
          className="inline-flex min-w-0 shrink items-center gap-1 rounded-xs text-xs text-muted-foreground focus-ring touch-hit hover:text-foreground hover:underline"
        >
          <span className="truncate">
            {repository.owner}/{repository.name}
          </span>
          {props.condensed && (
            <span
              className={cn(
                "font-mono tabular-nums",
                status.state === "unknown" ? "" : pullRequestTone(status.state),
              )}
            >
              #{status.ref.number}
            </span>
          )}
          <ArrowSquareOutIcon aria-hidden size={12} className="shrink-0" />
          <span className="sr-only">{`#${status.ref.number}, ${status.state}, open on GitHub`}</span>
        </button>
        {props.condensed && (
          <div className="min-w-0 flex-1 pl-1">
            <PrTitle actions={actions} condensed />
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {props.extensions?.headerActions?.(context)}
          <PrAgentChip detail={detail} compact={props.condensed} />
          <PrReviewButton />
          {actions.primary.kind !== "state" && (
            <PrPrimaryControl
              actions={actions}
              onBlocked={props.onBlocked}
              blockingCount={props.blockingCount}
            />
          )}
          {props.menu}
        </div>
      </div>
      {/* Folds away on scroll: the height animates; the title moves up into the first line. */}
      <div
        inert={props.condensed}
        aria-hidden={props.condensed || undefined}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--motion-base) ease-out motion-reduce:transition-none",
          props.condensed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-2 px-[var(--forge-gutter,1rem)] pt-1 pb-3">
            {!props.condensed && <PrTitle actions={actions} condensed={false} />}
            <PrByline actions={actions} />
          </div>
        </div>
      </div>
      {props.condensed && (
        <p className="fx-cross-in truncate px-[var(--forge-gutter,1rem)] pb-1.5 font-mono text-2xs text-subtle-foreground">
          {detail.baseBranch} ← {detail.headBranch}
        </p>
      )}
    </header>
  );
}
