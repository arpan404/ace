import { memo, useState, useId } from "react";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  DownloadIcon,
  EllipsisIcon,
  SaveIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { readNativeApi } from "~/nativeApi";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
  onLayoutChange,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  enableLocalFileLinks = true,
  workspaceRoot,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  onLayoutChange?: () => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readNativeApi();
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred while saving.",
        });
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <div
      className="glass-inset min-w-0 overflow-hidden border-border/35 border-y"
      data-proposed-plan-thread="true"
    >
      <div className="flex min-w-0 items-center gap-2 border-border/15 border-b px-2.5 py-1.5">
        <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground/58" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[10px] leading-4 font-medium tracking-[0.16em] text-muted-foreground/72 uppercase">
              Plan
            </span>
            <span className="min-w-0 truncate text-[12px] leading-4 font-medium text-foreground/86">
              {title}
            </span>
          </div>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Plan actions"
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm border-0 bg-transparent text-muted-foreground/66 shadow-none hover:bg-foreground/[0.055] hover:text-foreground"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleDownload}>
              <DownloadIcon aria-hidden="true" className="size-3.5" />
              Download as markdown
            </MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              <SaveIcon aria-hidden="true" className="size-3.5" />
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="px-3 py-2">
        <div className="relative">
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              isStreaming={false}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenFilePath={onOpenFilePath}
              enableLocalFileLinks={enableLocalFileLinks}
              {...(onLayoutChange ? { onLayoutChange } : {})}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              isStreaming={false}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenFilePath={onOpenFilePath}
              enableLocalFileLinks={enableLocalFileLinks}
              {...(onLayoutChange ? { onLayoutChange } : {})}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-background via-background/82 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-2.5 flex justify-start">
            <Button
              size="xs"
              variant="ghost"
              className="group h-6 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/68 hover:bg-transparent hover:text-foreground/90 active:bg-transparent"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="mr-1 size-3 text-muted-foreground/68 transition-colors group-hover:text-foreground/85"
                />
              ) : (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="mr-1 size-3 text-muted-foreground/68 transition-colors group-hover:text-foreground/85"
                />
              )}
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
