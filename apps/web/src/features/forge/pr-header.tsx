import { can, forgeDisplayName } from "@ace/ui-core";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { MergeMethod } from "@ace/ui-core";
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
  FileIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { pullRequestTone } from "@/components/pull-request-state.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import type { PrActions } from "./pr-actions.ts";
import { PrPrimaryButton } from "./pr-primary-button.tsx";
import { WorkTitle } from "@/components/work-heading.tsx";
import { PrMergeLines } from "./pr-merge-lines.tsx";
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
  return (
    <div className="group/title flex min-w-0 items-center gap-1">
      <h2
        title={title}
        className={cn(
          "min-w-0 truncate",
          props.condensed ? "text-ui font-medium" : "text-md leading-6 font-medium text-foreground",
        )}
      >
        {title}
      </h2>
      {edit}
    </div>
  );
}

/** "· Update" after the branch's freshness, offering to bring the branch up to date. */
export function BehindBase(props: {
  actions: PrActions;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { lifecycle, mergeState, context } = props.actions;
  const updates = (["update.merge", "update.rebase"] as const).filter(lifecycle.can);
  if (mergeState.state?.mergeState !== "BEHIND" || !updates.length) return null;
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <span aria-hidden className="px-0.5 text-xs text-subtle-foreground">
        ·
      </span>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Behind ${context.detail.baseBranch}: update`}
            className="inline-flex h-5 shrink-0 items-center rounded-xs px-0.5 font-sans text-xs font-medium text-foreground/90 transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground"
          />
        }
      >
        Update
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
        <PopoverTitle className="text-ui font-medium">
          {`Behind ${context.detail.baseBranch}`}
        </PopoverTitle>
        <div className="flex gap-2">
          {updates.map((kind) => (
            <Button
              key={kind}
              size="sm"
              disabled={lifecycle.blocked}
              onClick={() => {
                props.onOpenChange(false);
                void lifecycle.apply({ kind });
              }}
            >
              {kind === "update.merge" ? "Update branch" : "Update with rebase"}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
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
  if (
    !can(
      actions.context.detail,
      actions.primary.kind === "ready"
        ? "reviews.edit"
        : actions.primary.kind === "auto-merge" || actions.primary.kind === "auto-merge-ready"
          ? "reviews.autoMerge"
          : "reviews.merge",
    )
  )
    return null;
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

/**
 * The PR panel's header: repository and number in the state's colour, the stack chip, one
 * primary control and ⋯ on the first line; then the title, author and checkout, and the
 * branches with the diff size. Scrolled, it folds to the first line plus a thin branch line.
 */
export function PrHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  condensed: boolean;
  behindOpen: boolean;
  /** The merge gates, folded away with the title block. */
  gates: ReactNode;
  onBehindOpen(open: boolean): void;
  onBack?: (() => void) | undefined;
  onOpen(number: number): void;
  /** Takes the person to what blocks the merge. */
  onBlocked?: (() => void) | undefined;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy the checkout command" }),
  );
  const openUrl = (url: string, click?: MouseEvent) =>
    void openWeb(url, click).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  const branches = (
    <>
      {detail.baseBranch} ← {detail.headBranch}
    </>
  );
  return (
    <header className="shrink-0 pt-2">
      <div className="flex h-7 min-w-0 items-center gap-1 px-[var(--forge-gutter,1rem)]">
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
          className="inline-flex min-w-0 shrink items-center gap-1 rounded-xs text-xs text-muted-foreground focus-ring touch-hit hover:underline"
        >
          <span className="truncate font-medium">
            {repository.owner}/{repository.name}
          </span>
          <span
            className={cn(
              "font-mono tabular-nums",
              status.state === "unknown" ? "" : pullRequestTone(status.state),
            )}
          >
            #{status.ref.number}
          </span>
          <ArrowSquareOutIcon aria-hidden size={12} />
          <span className="sr-only">{`${status.state}, open on ${forgeDisplayName(status.ref.repository.forge)}`}</span>
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
          <PrPrimaryControl actions={actions} onBlocked={props.onBlocked} />
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
          <div className="mt-1 space-y-1.5 px-[var(--forge-gutter,1rem)] pb-2.5">
            {!props.condensed && <PrTitle actions={actions} condensed={false} />}
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
              <span className="max-w-32 shrink-0 truncate text-foreground">{detail.author}</span>
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <span className="shrink-0 whitespace-nowrap">
                <PrTime at={detail.updatedAt} prefix="updated " />
              </span>
              <button
                type="button"
                aria-label={copied ? "Checkout command copied" : "Copy checkout command"}
                onClick={() => copy(checkout)}
                title={checkout}
                className="ml-auto min-w-0 truncate rounded-xs bg-accent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:bg-hover hover:text-foreground"
              >
                {copied ? "Copied" : checkout}
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-xs text-subtle-foreground">
              <span className="inline-flex min-w-0 items-center gap-2 font-mono">
                <span className="truncate">{branches}</span>
                <BehindBase
                  actions={actions}
                  open={props.behindOpen}
                  onOpenChange={props.onBehindOpen}
                />
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 tabular-nums">
                <FileIcon aria-hidden size={12} />
                {detail.changedFiles}
                <span className="sr-only">files</span>
                {detail.additions !== undefined && detail.deletions !== undefined && (
                  <DiffStat additions={detail.additions} deletions={detail.deletions} />
                )}
              </span>
            </div>
          </div>
          {props.gates}
          <PrMergeLines actions={actions} />
        </div>
      </div>
      {props.condensed && (
        <p className="fx-cross-in truncate px-[var(--forge-gutter,1rem)] pb-1.5 font-mono text-2xs text-subtle-foreground">
          {branches}
        </p>
      )}
    </header>
  );
}
