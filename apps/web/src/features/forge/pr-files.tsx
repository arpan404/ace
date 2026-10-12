import { useMemo, useRef, useState } from "react";
import type { ForgePrDetail, ForgeRepository, ForgeFile } from "@ace/protocol";
import type { FileChanges } from "@ace/ui-core";
import {
  ParagraphIcon,
  RowsIcon,
  ColumnsIcon,
  TextAlignLeftIcon,
  ArrowsInLineVerticalIcon,
  TreeStructureIcon,
  PlusCircleIcon,
  MinusCircleIcon,
  PencilCircleIcon,
  ArrowCircleRightIcon,
} from "@phosphor-icons/react";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { FileDiffBlock, FileTree, freshView, type FileView } from "@/features/panels/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readForge } from "./source.ts";
import { QueryState } from "./query-state.tsx";
import { usePrCommits } from "./pr-commits.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions, PrDiffContext } from "./pr-extensions.ts";
import { PrFileReview } from "./pr-file-review.tsx";
import { usePrReview } from "./pr-review-context.tsx";

const fileStatus = (file: ForgeFile) =>
  file.status === "added"
    ? "added"
    : file.status === "removed"
      ? "deleted"
      : file.status === "renamed"
        ? "moved"
        : "modified";
export function PrFiles(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
}) {
  return <PrFileRange key={`${props.detail.status.headSha}/${props.detail.baseSha}`} {...props} />;
}
function PrFileRange(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
}) {
  const [commit, setCommit] = useState("");
  const commits = usePrCommits(props);
  return (
    <PrFilePage key={commit} {...props} commit={commit} onCommit={setCommit} commits={commits} />
  );
}
function PrFilePage(
  props: Parameters<typeof PrFileRange>[0] & {
    commit: string;
    onCommit(commit: string): void;
    commits: ReturnType<typeof usePrCommits>;
  },
) {
  const [page, setPage] = useState(1);
  const filesElement = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string>();
  const scope = `forge:${props.workspaceId}`;
  const workspace = useScopeWorkspace(scope);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const [whitespace, setWhitespace] = useState(false);
  const [tree, setTree] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [views, setViews] = useState<ReadonlyMap<string, FileView>>(new Map());
  const toast = useToast();
  const review = usePrReview();
  const ref = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      ref,
      "files",
      props.detail.baseSha,
      props.detail.status.headSha,
      props.commit,
      page,
    ],
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.files",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: ref.number,
          headSha: props.detail.status.headSha,
          baseSha: props.detail.baseSha,
          page,
          ...(props.commit ? { commit: props.commit } : {}),
        },
        signal,
      );
      if (result.resource !== "prFiles") throw new Error("No changed-file response.");
      return result.value;
    },
  });
  const inputs = useMemo(
    (): FileChanges[] =>
      query.data?.files.map((file) => ({
        path: file.path,
        changes: [
          {
            path: file.previousPath ?? file.path,
            kind:
              file.status === "added"
                ? "add"
                : file.status === "removed"
                  ? "delete"
                  : file.previousPath
                    ? "move"
                    : "update",
            ...(file.previousPath ? { movePath: file.path } : {}),
            diff: file.patch ?? "",
          },
        ],
      })) ?? [],
    [query.data],
  );
  const diffs = useFileChanges(inputs);
  const byPath = new Map(diffs.files.map((file) => [file.path, file]));
  const diffContext: PrDiffContext | undefined = query.data
    ? {
        ...props.context,
        files: query.data,
        disabled: props.context.disabled || query.isFetching || query.isError,
      }
    : undefined;
  const nativeViewed =
    !props.commit && review?.state?.headSha === props.detail.status.headSha
      ? review.state.viewed?.filter((file) => file.state === "VIEWED")
      : undefined;
  const viewedCount = props.extensions?.viewedCount
    ? diffContext && props.extensions.viewedCount(diffContext)
    : nativeViewed?.length;
  const fileCount = props.commit ? (query.data?.files.length ?? 0) : props.detail.changedFiles;
  return (
    <section aria-label="Hosted PR diff" className="min-w-0">
      <div
        role="toolbar"
        aria-label="Diff controls"
        className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-1.5"
      >
        <select
          aria-label="Commit range"
          value={props.commit}
          onChange={(e) => props.onCommit(e.target.value)}
          className="max-w-56 rounded-sm bg-transparent py-1 text-sm focus-ring"
        >
          <option value="">All commits</option>
          {props.commits.data?.commits.map((c) => (
            <option key={c.sha} value={c.sha}>
              {c.sha.slice(0, 7)} {c.message.split("\n")[0]}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {fileCount} files{props.commit ? " on this page" : ""}
          {viewedCount !== undefined && ` · ${viewedCount} / ${fileCount} viewed`}
        </span>
        <div className="ml-auto flex gap-1">
          <IconButton
            icon={ParagraphIcon}
            label="Show whitespace"
            pressed={whitespace}
            onClick={() => setWhitespace(!whitespace)}
          />
          <div role="group" aria-label="Diff layout" className="flex rounded-card bg-muted">
            <IconButton
              icon={RowsIcon}
              label="Unified diff"
              pressed={mode === "unified"}
              onClick={() => setMode("unified")}
            />
            <IconButton
              icon={ColumnsIcon}
              label="Split diff"
              pressed={mode === "split"}
              onClick={() => setMode("split")}
            />
          </div>
          <IconButton
            icon={TextAlignLeftIcon}
            label="Wrap lines"
            pressed={wrap}
            onClick={() => setWrap(!wrap)}
          />
          <IconButton
            icon={ArrowsInLineVerticalIcon}
            label={collapsed ? "Expand all files" : "Collapse all files"}
            onClick={() => {
              setCollapsed(!collapsed);
              setViews(new Map());
            }}
          />
          <IconButton
            icon={TreeStructureIcon}
            label="Show file tree"
            pressed={tree}
            onClick={() => setTree(!tree)}
          />
        </div>
      </div>
      <div className="px-3">
        <QueryState query={props.commits} />
        <QueryState query={query} />
      </div>
      {props.commits.data?.truncated && (
        <p role="status" className="p-3 text-sm">
          GitHub exposes the first 250 commits. Open GitHub for the full range.
        </p>
      )}
      {query.data && diffContext && (
        <>
          <p className="sr-only">
            {props.commit
              ? "Commit compared with its first parent"
              : "PR compared with its merge base"}
            : {query.data.baseSha} ← {query.data.headSha}
          </p>
          {query.data.truncated && (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              Some patches are binary, too large, omitted or truncated. GitHub exposes at most 3,000
              PR files. Open GitHub for the complete diff.
            </p>
          )}
          <div className="flex min-w-0">
            {tree && (
              <FileTree
                threadId={scope}
                tabKey={workspace.active}
                className="w-48 shrink-0 border-r border-border"
                files={query.data.files.map((file) => ({
                  path: file.path,
                  additions: file.additions,
                  deletions: file.deletions,
                }))}
                current={current}
                viewed={
                  new Set(
                    query.data.files
                      .filter((file) =>
                        props.extensions?.viewed
                          ? props.extensions.viewed(file, diffContext)?.checked
                          : nativeViewed?.some((viewed) => viewed.path === file.path),
                      )
                      .map((file) => file.path),
                  )
                }
                comments={new Map()}
                onJump={(index) => {
                  const file = query.data?.files[index];
                  if (file) setCurrent(file.path);
                  filesElement.current
                    ?.querySelector<HTMLElement>(`[id="pr-file-${page}-${index}"]`)
                    ?.scrollIntoView({ block: "start" });
                }}
              />
            )}
            <div ref={filesElement} className="min-w-0 flex-1">
              {query.data.files.map((file, index) => {
                const diff = byPath.get(file.path);
                const Icon =
                  file.status === "added"
                    ? PlusCircleIcon
                    : file.status === "removed"
                      ? MinusCircleIcon
                      : file.status === "renamed"
                        ? ArrowCircleRightIcon
                        : PencilCircleIcon;
                const viewed = props.extensions?.viewed?.(file, diffContext);
                const view = views.get(file.path) ?? { ...freshView, open: !collapsed };
                return (
                  <PrFileReview key={file.path} file={file} context={diffContext}>
                    {(native) => (
                      <div className="border-b border-border">
                        {diff ? (
                          <FileDiffBlock
                            id={`pr-file-${page}-${index}`}
                            file={{
                              ...diff,
                              status: fileStatus(file),
                              additions: file.additions,
                              deletions: file.deletions,
                            }}
                            view={view}
                            onView={(next) =>
                              setViews((previous) => new Map(previous).set(file.path, next))
                            }
                            mode={mode}
                            wrap={wrap}
                            whitespace={whitespace}
                            statusIcon={<Icon aria-label={file.status} size={18} />}
                            highlighted={() => false}
                            renderAnnotation={(target) =>
                              props.extensions?.annotation?.(file.path, target, diffContext)
                            }
                            onComment={
                              props.extensions?.onLineComment && !diffContext.disabled
                                ? (range) =>
                                    props.extensions?.onLineComment?.(file.path, range, diffContext)
                                : !props.extensions?.onLineComment
                                  ? native.onComment
                                  : undefined
                            }
                            viewed={props.extensions?.viewed ? viewed?.checked : native.viewed}
                            actions={
                              viewed ? (
                                <label className="flex shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
                                  <input
                                    type="checkbox"
                                    aria-label={`Viewed ${file.path}`}
                                    checked={viewed.checked}
                                    disabled={diffContext.disabled || viewed.disabled}
                                    onChange={(e) =>
                                      void viewed
                                        .change(e.target.checked)
                                        .catch(() =>
                                          toast.error({ title: "Couldn't save viewed state" }),
                                        )
                                    }
                                    className="size-4 rounded-sm focus-ring"
                                  />
                                  Viewed
                                </label>
                              ) : !props.extensions?.viewed ? (
                                native.actions
                              ) : null
                            }
                          />
                        ) : (
                          <p className="p-3 text-sm">Preparing {file.path}…</p>
                        )}
                        {view.open && (file.patch === null || file.truncated) && (
                          <p role="status" className="p-3 text-sm text-muted-foreground">
                            {file.patch === null
                              ? "Binary or large file: GitHub did not provide a text patch."
                              : "This patch is truncated."}{" "}
                            Open GitHub to inspect the complete file.
                          </p>
                        )}
                      </div>
                    )}
                  </PrFileReview>
                );
              })}
              {!query.data.files.length && (
                <p className="p-3 text-sm text-muted-foreground">No changed files on this page.</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 p-3">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous files
            </Button>
            <span className="text-sm text-muted-foreground">Page {page}</span>
            <Button
              disabled={!query.data.nextPage}
              onClick={() => query.data?.nextPage && setPage(query.data.nextPage)}
            >
              Next files
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
