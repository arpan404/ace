import { type TurnId } from "@ace/contracts";
import { useEffect, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel } from "./DiffStatLabel";
import { hasNonZeroStat } from "./diffStat";

export function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onLayoutChange?: () => void;
}) {
  const { files, allDirectoriesExpanded, onLayoutChange, onOpenTurnDiff, turnId } = props;
  const treeNodes = buildTurnDiffTree(files);
  const directoryPathsKey = collectDirectoryPaths(treeNodes).join("\u0000");
  const allDirectoryExpansionState = buildDirectoryExpansionState(
    directoryPathsKey ? directoryPathsKey.split("\u0000") : [],
    allDirectoriesExpanded,
  );
  const resetKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}:${directoryPathsKey}`;

  return (
    <ChangedFilesTreeContent
      key={resetKey}
      allDirectoryExpansionState={allDirectoryExpansionState}
      onOpenTurnDiff={onOpenTurnDiff}
      treeNodes={treeNodes}
      turnId={turnId}
      {...(onLayoutChange ? { onLayoutChange } : {})}
    />
  );
}

function ChangedFilesTreeContent(props: {
  turnId: TurnId;
  treeNodes: ReadonlyArray<TurnDiffTreeNode>;
  allDirectoryExpansionState: Record<string, boolean>;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onLayoutChange?: () => void;
}) {
  const { allDirectoryExpansionState, onLayoutChange, onOpenTurnDiff, treeNodes, turnId } = props;
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(
    allDirectoryExpansionState,
  );
  useEffect(() => {
    onLayoutChange?.();
  }, [expandedDirectories, onLayoutChange]);

  const toggleDirectory = (pathValue: string, fallbackExpanded: boolean) => {
    setExpandedDirectories((current) => ({
      ...current,
      [pathValue]: !(current[pathValue] ?? fallbackExpanded),
    }));
  };

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 16;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? false;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex min-h-7 w-full items-center gap-2 rounded-[var(--control-radius)] py-1 pr-2 text-left text-muted-foreground/72 transition-[background-color,color] duration-150 hover:bg-foreground/[0.045] hover:text-foreground/90"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path, false)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/54 transition-[color,transform] duration-150 group-hover:text-foreground/72",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground/58 transition-colors group-hover:text-foreground/68" />
            ) : (
              <FolderClosedIcon className="size-4 shrink-0 text-muted-foreground/58 transition-colors group-hover:text-foreground/68" />
            )}
            <span className="truncate font-mono text-[12px] leading-5 text-inherit">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 pl-3 font-mono text-[11px] leading-5 tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex min-h-7 w-full items-center gap-2 rounded-[var(--control-radius)] py-1 pr-2 text-left text-muted-foreground/72 transition-[background-color,color] duration-150 hover:bg-foreground/[0.045] hover:text-foreground/90"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <FileIcon className="size-4 shrink-0 text-muted-foreground/44 transition-colors group-hover:text-foreground/60" />
        <span className="truncate font-mono text-[12px] leading-5 text-inherit">{node.name}</span>
        {node.stat && (
          <span className="ml-auto shrink-0 pl-3 font-mono text-[11px] leading-5 tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
}

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

function buildDirectoryExpansionState(
  directoryPaths: ReadonlyArray<string>,
  expanded: boolean,
): Record<string, boolean> {
  const expandedState: Record<string, boolean> = {};
  for (const directoryPath of directoryPaths) {
    expandedState[directoryPath] = expanded;
  }
  return expandedState;
}
