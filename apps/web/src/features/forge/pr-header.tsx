import { useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  FileIcon,
  PencilSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { pullRequestTone } from "@/components/pull-request-state.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import type { PrActions } from "./pr-actions.ts";
import { PrPrimaryButton } from "./pr-primary-button.tsx";
import { PrStackChip } from "./pr-stack-chip.tsx";

/** The title, editable in place where GitHub lets this account change it. */
function PrTitle(props: { actions: PrActions; condensed: boolean }) {
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
  return (
    <div className="group/title flex min-w-0 items-center gap-1">
      <h2
        title={title}
        className={cn(
          "min-w-0 truncate",
          props.condensed
            ? "text-ui font-medium"
            : "text-base leading-6 font-semibold text-foreground",
        )}
      >
        {title}
      </h2>
      {editable && !props.condensed && (
        <IconButton
          icon={PencilSimpleIcon}
          label="Edit title"
          size="sm"
          disabled={lifecycle.blocked}
          className="opacity-0 group-focus-within/title:opacity-100 group-hover/title:opacity-100 pointer-coarse:opacity-100"
          onClick={() => setDraft(title)}
        />
      )}
    </div>
  );
}

/** An amber triangle beside the base when the branch is behind it, offering to update. */
function BehindBase(props: { actions: PrActions }) {
  const { lifecycle, mergeState, context } = props.actions;
  const updates = (["update.merge", "update.rebase"] as const).filter(lifecycle.can);
  if (mergeState.state?.mergeState !== "BEHIND" || !updates.length) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Behind ${context.detail.baseBranch}`}
            className="inline-flex rounded-xs text-status-needs-you focus-ring touch-hit"
          />
        }
      >
        <WarningIcon aria-hidden size={12} />
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
              onClick={() => void lifecycle.apply({ kind })}
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
 * The PR panel's header: repository and number in the state's colour, the stack chip, one
 * primary control and ⋯ on the first line; then the title, author and checkout, and the
 * branches with the diff size. Scrolled, it folds to the first line plus a thin branch line.
 */
export function PrHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  condensed: boolean;
  onBack?: (() => void) | undefined;
  onOpen(number: number): void;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const toast = useToast();
  const { copied, copy } = useCopy();
  const openUrl = (url: string) =>
    void openExternal(url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  const working = actions.writes.pending || actions.mergeState.pending || actions.lifecycle.pending;
  const branches = (
    <>
      {detail.baseBranch} ← {detail.headBranch}
    </>
  );
  return (
    <header className="shrink-0 px-4 pt-2 pb-2">
      <div className="flex h-7 min-w-0 items-center gap-1">
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
          onClick={() => openUrl(status.url)}
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
          <span className="sr-only">{`${status.state}, open on GitHub`}</span>
        </button>
        {props.condensed && (
          <div className="min-w-0 flex-1 pl-1">
            <PrTitle actions={actions} condensed />
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {props.extensions?.headerActions?.(context)}
          {actions.stack && (
            <PrStackChip
              workspaceId={context.workspaceId}
              detail={detail}
              stack={actions.stack}
              onRefresh={() => void context.refresh()}
              onOpen={props.onOpen}
            />
          )}
          <PrPrimaryButton
            primary={actions.primary}
            blocked={actions.primaryBlocked}
            working={working}
            onRun={() => void actions.runPrimary()}
          />
          {props.menu}
        </div>
      </div>
      {props.condensed ? (
        <p className="truncate font-mono text-2xs text-subtle-foreground">{branches}</p>
      ) : (
        <div className="mt-1 space-y-1">
          <PrTitle actions={actions} condensed={false} />
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
            <span className="truncate">{detail.author}</span>
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <PrTime at={detail.updatedAt} prefix="updated " />
            <button
              type="button"
              aria-label={copied ? "Checkout command copied" : "Copy checkout command"}
              onClick={() => copy(checkout)}
              title={checkout}
              className="ml-auto max-w-[55%] truncate rounded-xs px-1 font-mono text-xs text-subtle-foreground focus-ring touch-hit hover:bg-accent hover:text-foreground"
            >
              {copied ? "Copied" : checkout}
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-2 pt-1 text-xs text-subtle-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
              <span className="truncate">{branches}</span>
              <BehindBase actions={actions} />
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
      )}
    </header>
  );
}
