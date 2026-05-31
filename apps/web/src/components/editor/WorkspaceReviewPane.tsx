import {
  BotIcon,
  Columns2Icon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitBranchIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSetting } from "~/hooks/useSettings";
import {
  formatFileChangeType,
  getRenderablePatch,
  resolveFileDiffPath,
  summarizeFileDiff,
} from "~/lib/diffPatch";
import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import WorkspaceReviewDiff from "./WorkspaceReviewDiff";

interface WorkspaceReviewPaneProps {
  readonly connectionUrl?: string | null | undefined;
  readonly cwd: string | null;
  readonly filePath: string;
  readonly onAskAgent: (filePath: string) => void;
  readonly onClose: () => void;
  readonly onOpenFile: (filePath: string) => void;
  readonly onOpenToSide: (filePath: string) => void;
  readonly onQueueContext: (filePath: string) => void;
  readonly resolvedTheme: "light" | "dark";
}

type WorkspaceReviewDiffRenderMode = "stacked" | "split";

function WorkspaceReviewPane(props: WorkspaceReviewPaneProps) {
  const diffWordWrapSetting = useSetting("diffWordWrap");
  const [diffRenderMode, setDiffRenderMode] = useState<WorkspaceReviewDiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(diffWordWrapSetting);
  const diffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      connectionUrl: props.connectionUrl ?? null,
      cwd: props.cwd,
      enabled: props.cwd !== null,
      relativePath: props.filePath,
    }),
  );
  const renderablePatch = useMemo(
    () => getRenderablePatch(diffQuery.data?.diff, `workspace-review:${props.filePath}`),
    [diffQuery.data?.diff, props.filePath],
  );
  const fileDiff = useMemo(() => {
    if (renderablePatch?.kind !== "files") {
      return null;
    }
    return (
      renderablePatch.files.find(
        (candidate) => resolveFileDiffPath(candidate) === props.filePath,
      ) ??
      renderablePatch.files[0] ??
      null
    );
  }, [props.filePath, renderablePatch]);
  const stat = fileDiff ? summarizeFileDiff(fileDiff) : null;
  const changeType = fileDiff ? formatFileChangeType(fileDiff) : "modified";

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/72 px-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <GitBranchIcon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12px] font-medium text-foreground">
              {props.filePath}
            </span>
            {stat ? (
              <>
                <span className="hidden shrink-0 rounded-md bg-foreground/6 px-1.5 py-px text-[9px] font-semibold text-muted-foreground uppercase sm:inline-flex">
                  {changeType}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-success">
                  +{stat.additions}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-destructive">
                  -{stat.deletions}
                </span>
              </>
            ) : null}
          </div>
          <div className="truncate text-[10.5px] text-muted-foreground/75">
            Review working tree changes before bringing the agent in.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToggleGroup
            className="mr-1 shrink-0 gap-0.5 rounded-md border border-border/70 bg-background/42 p-0.5"
            variant="default"
            size="sm"
            value={[diffRenderMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                setDiffRenderMode(next);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label="Unified diff view"
                    className="size-6 rounded-[5px] px-0 text-muted-foreground/72 hover:bg-accent hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
                    value="stacked"
                  />
                }
              >
                <Rows3Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Unified diff view</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label="Side-by-side diff view"
                    className="size-6 rounded-[5px] px-0 text-muted-foreground/72 hover:bg-accent hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
                    value="split"
                  />
                }
              >
                <Columns2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Side-by-side diff view</TooltipPopup>
            </Tooltip>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                  }
                  variant="default"
                  size="sm"
                  className="size-7 rounded-md px-0 text-muted-foreground/72 hover:bg-accent hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
                  pressed={diffWordWrap}
                  onPressedChange={(pressed) => {
                    setDiffWordWrap(Boolean(pressed));
                  }}
                />
              }
            >
              <TextWrapIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            </TooltipPopup>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-md px-2 text-[11px]"
            onClick={() => props.onAskAgent(props.filePath)}
          >
            <BotIcon className="size-3.5" />
            Review
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-md px-2 text-[11px]"
            onClick={() => props.onQueueContext(props.filePath)}
          >
            <MessageSquarePlusIcon className="size-3.5" />
            Queue
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md text-muted-foreground/72 hover:bg-accent hover:text-foreground"
                  onClick={() => props.onOpenFile(props.filePath)}
                  aria-label="Open file"
                />
              }
            >
              <FileCode2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open file</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md text-muted-foreground/72 hover:bg-accent hover:text-foreground"
                  onClick={() => props.onOpenToSide(props.filePath)}
                  aria-label="Open to side"
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open to side</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md text-muted-foreground/72 hover:bg-accent hover:text-foreground"
                  onClick={props.onClose}
                  aria-label="Close review"
                />
              }
            >
              <XIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close review</TooltipPopup>
          </Tooltip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {diffQuery.isPending || diffQuery.fetchStatus === "fetching" ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" />
            Loading file diff
          </div>
        ) : diffQuery.isError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
            Failed to load file diff.
          </div>
        ) : renderablePatch === null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No working tree diff for this file.
          </div>
        ) : renderablePatch.kind === "raw" ? (
          <div className="h-full overflow-auto px-4 py-3">
            <p className="mb-2 text-[11px] text-muted-foreground/70">{renderablePatch.reason}</p>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              {renderablePatch.text}
            </pre>
          </div>
        ) : fileDiff ? (
          <div className="min-h-full bg-background">
            <WorkspaceReviewDiff
              fileDiff={fileDiff}
              filePath={props.filePath}
              renderMode={diffRenderMode}
              resolvedTheme={props.resolvedTheme}
              wordWrap={diffWordWrap}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No renderable diff for this file.
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(WorkspaceReviewPane);
