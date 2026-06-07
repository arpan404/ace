import {
  BotIcon,
  ClipboardPlusIcon,
  Columns2Icon,
  Loader2Icon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { APP_EDITOR_CHROME_HEADER_CLASS_NAME } from "~/lib/appChrome";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSetting } from "~/hooks/useSettings";
import { getRenderablePatch, resolveFileDiffPath, summarizeFileDiff } from "~/lib/diffPatch";
import type { WorkspaceCodeComment } from "~/lib/editor/workspaceDesigner";
import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import WorkspaceReviewDiff from "./WorkspaceReviewDiff";

interface WorkspaceReviewPaneProps {
  readonly codeComments: readonly WorkspaceCodeComment[];
  readonly connectionUrl?: string | null | undefined;
  readonly cwd: string | null;
  readonly filePath: string;
  readonly onAddCodeComment: (comment: WorkspaceCodeComment) => void;
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

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header
        className={`flex h-9 shrink-0 items-center gap-3 px-3 ${APP_EDITOR_CHROME_HEADER_CLASS_NAME}`}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className="truncate font-mono text-[12px] font-medium text-foreground/92"
            title={props.filePath}
          >
            {props.filePath}
          </span>
          {stat ? (
            <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
              <span className="text-success/90">+{stat.additions}</span>
              <span className="text-destructive/90">-{stat.deletions}</span>
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToggleGroup
            className="shrink-0 gap-0.5"
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
                    className="size-7 rounded-md bg-transparent px-0 text-muted-foreground/58 hover:bg-transparent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground"
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
                    className="size-7 rounded-md bg-transparent px-0 text-muted-foreground/58 hover:bg-transparent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground"
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
                  className="size-7 rounded-md bg-transparent px-0 text-muted-foreground/58 hover:bg-transparent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground"
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
          <div className="mx-1 h-4 w-px bg-border/60" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md bg-transparent text-muted-foreground/64 hover:bg-transparent hover:text-foreground"
                  onClick={() => props.onAskAgent(props.filePath)}
                  aria-label="Ask agent to review"
                />
              }
            >
              <BotIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Ask agent to review</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md bg-transparent text-muted-foreground/64 hover:bg-transparent hover:text-foreground"
                  onClick={() => props.onQueueContext(props.filePath)}
                  aria-label="Queue diff context"
                />
              }
            >
              <ClipboardPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Queue diff context</TooltipPopup>
          </Tooltip>
          <div className="mx-1 h-4 w-px bg-border/60" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-md bg-transparent text-muted-foreground/58 hover:bg-transparent hover:text-foreground"
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
              codeComments={props.codeComments}
              cwd={props.cwd}
              fileDiff={fileDiff}
              filePath={props.filePath}
              onAddCodeComment={props.onAddCodeComment}
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
