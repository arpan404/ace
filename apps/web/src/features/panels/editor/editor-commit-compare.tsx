import { useClient } from "@ace/client-react";
import { CheckIcon, CopyIcon, GitCommitIcon, XIcon } from "@ace/icons";
import { gitPatchFiles } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { sceneBar } from "@/components/ui/rules.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import {
  formatRelativeWords,
  readGitCommitDiff,
  type CommitDiffTarget,
} from "@/lib/git-history.ts";
import { FileDiffBlock, type FileView } from "../changes/file-diff.tsx";
import { freshView } from "../changes/file-view.ts";

interface CommitDiffState {
  key: string;
  patch: string;
  truncated: boolean;
  nextOffset: number | undefined;
  validator: string | undefined;
  failed: boolean;
  loadingMore: boolean;
}

/**
 * Read-only diff of one commit's change to a file (reusing the Changes/Compare `FileDiffBlock`
 * shell and the commit-scoped `git.diff` op). Opened from Timeline or Inline Blame.
 */
export function EditorCommitCompare(props: {
  threadId: string;
  target: CommitDiffTarget;
  onClose(): void;
  now?: (() => number) | undefined;
}) {
  const { threadId, target, onClose } = props;
  const client = useClient();
  const requestKey = `${threadId}:${target.sha}:${target.path}:${target.previousPath ?? ""}`;

  const [state, setState] = useState<CommitDiffState | undefined>(undefined);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [view, setView] = useState<FileView>(freshView);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void readGitCommitDiff(client, threadId, {
      path: target.path,
      from: target.previousPath,
      commit: target.sha,
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setState({
          key: requestKey,
          patch: result.patch,
          truncated: result.truncated,
          nextOffset: result.nextOffset,
          validator: result.validator,
          failed: false,
          loadingMore: false,
        });
      },
      () => {
        if (controller.signal.aborted) return;
        setState({
          key: requestKey,
          patch: "",
          truncated: false,
          nextOffset: undefined,
          validator: undefined,
          failed: true,
          loadingMore: false,
        });
      },
    );
    return () => controller.abort();
  }, [client, threadId, target.path, target.previousPath, target.sha, requestKey]);

  const active = state?.key === requestKey ? state : undefined;
  const patch = active?.patch;
  const files = useMemo(() => (patch ? gitPatchFiles(patch) : []), [patch]);
  const diff = files[0];

  const loadMore = () => {
    if (!active || active.nextOffset === undefined || active.loadingMore) return;
    setState({ ...active, loadingMore: true });
    void readGitCommitDiff(client, threadId, {
      path: target.path,
      from: target.previousPath,
      commit: target.sha,
      offset: active.nextOffset,
      expected: active.validator,
    }).then(
      (next) => {
        setState((prev) =>
          prev && prev.key === requestKey
            ? {
                ...prev,
                patch: prev.patch + next.patch,
                truncated: next.truncated,
                nextOffset: next.nextOffset,
                loadingMore: false,
              }
            : prev,
        );
      },
      () => {
        setState((prev) =>
          prev && prev.key === requestKey
            ? {
                ...prev,
                failed: true,
                loadingMore: false,
              }
            : prev,
        );
      },
    );
  };

  const copySha = () => {
    void navigator.clipboard?.writeText(target.sha).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const [now] = useState(() => (props.now ?? Date.now)());
  const age = formatRelativeWords(target.authoredAt, now);

  return (
    <div
      role="region"
      aria-label={`Changes in ${target.shortSha} for ${target.path}`}
      data-part="commit-compare"
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className={cn(
          "sticky top-0 z-[3] flex min-h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-xs",
          sceneBar,
        )}
      >
        <GitCommitIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-foreground">{target.shortSha}</span>
        <span
          title={target.subject}
          className="min-w-0 flex-1 truncate font-medium text-foreground"
        >
          {target.subject}
        </span>
        <span className="hidden shrink-0 text-subtle-foreground sm:inline">
          {target.authorName} · {age}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <div
            role="group"
            aria-label="Diff layout"
            className="inline-flex h-6 items-center rounded-sm border border-border-soft p-0.5"
          >
            <button
              type="button"
              aria-pressed={mode === "split"}
              onClick={() => setMode("split")}
              className={cn(
                "h-5 rounded-[3px] px-1.5 text-[11px] transition-colors",
                mode === "split"
                  ? "bg-active text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Split
            </button>
            <button
              type="button"
              aria-pressed={mode === "unified"}
              onClick={() => setMode("unified")}
              className={cn(
                "h-5 rounded-[3px] px-1.5 text-[11px] transition-colors",
                mode === "unified"
                  ? "bg-active text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Unified
            </button>
          </div>
          <IconButton
            label={copied ? "Copied commit id" : "Copy commit id"}
            icon={copied ? CheckIcon : CopyIcon}
            size="sm"
            onClick={copySha}
            className="size-6 rounded-sm hover:bg-hover"
          />
          <IconButton
            label="Close commit diff"
            icon={XIcon}
            size="sm"
            onClick={onClose}
            className="size-6 rounded-sm hover:bg-hover"
          />
        </div>
      </div>

      {!active ? (
        <div
          className="flex flex-1 items-center justify-center gap-2 text-xs text-subtle-foreground"
          aria-busy="true"
        >
          <Spinner />
          Reading changes…
        </div>
      ) : active.failed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
          <p>Couldn&apos;t read the changes in {target.shortSha}.</p>
        </div>
      ) : diff ? (
        <>
          <FileDiffBlock
            file={diff}
            view={view}
            onView={setView}
            mode={mode}
            wrap={false}
            highlighted={() => false}
            renderAnnotation={() => null}
          />
          {active.truncated && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-subtle-foreground">
              <span>This change is long; the rest is not shown yet.</span>
              {active.nextOffset !== undefined && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={active.loadingMore}
                  onClick={loadMore}
                >
                  {active.loadingMore ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-xs text-subtle-foreground">
          No textual changes to {target.path} in {target.shortSha}.
        </div>
      )}
    </div>
  );
}
