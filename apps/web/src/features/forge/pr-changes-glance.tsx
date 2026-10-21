import { ArrowRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ForgePrDetail } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { plainRow } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { usePrFilePages } from "./pr-file-pages.ts";
import { PrSection } from "./pr-section.tsx";
import { biggestFiles, type GlanceFile } from "./pr-summary-model.ts";
import { readFailureText } from "./query-state.tsx";

const shown = 6;

/** A file's change as a 6px bar: its length the share of the biggest file, split + and −. */
function MicroBar(props: { file: GlanceFile }) {
  const { file } = props;
  const total = Math.max(1, file.additions + file.deletions);
  return (
    <span
      aria-hidden
      className="flex h-1.5 w-16 shrink-0 justify-end overflow-hidden rounded-full @max-[30rem]/pr:hidden"
    >
      <span className="flex h-full" style={{ width: `${Math.max(4, file.scale * 100)}%` }}>
        <span
          className="h-full bg-status-done"
          style={{ width: `${(file.additions / total) * 100}%` }}
        />
        <span
          className="h-full bg-status-failed"
          style={{ width: `${(file.deletions / total) * 100}%` }}
        />
      </span>
    </span>
  );
}

/**
 * The few files that changed most, each with its folder muted, a proportional bar and its
 * line counts. A file opens the Code tab at that file. They come from the detail's file list,
 * or from the first files page when the detail has none.
 */
export function PrChangesGlance(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onOpenCode(path?: string): void;
}) {
  if (props.detail.files !== undefined)
    return <GlanceFromDetail detail={props.detail} onOpenCode={props.onOpenCode} />;
  return (
    <GlanceFromPages
      workspaceId={props.workspaceId}
      detail={props.detail}
      onOpenCode={props.onOpenCode}
    />
  );
}

function GlanceFrame(props: {
  detail: ForgePrDetail;
  onOpenCode(path?: string): void;
  children: ReactNode;
}) {
  return (
    <PrSection
      title="Changes"
      count={props.detail.changedFiles}
      fixed
      action={
        <Button variant="ghost" size="xs" onClick={() => props.onOpenCode()}>
          Open Code
          <ArrowRightIcon aria-hidden size={12} />
        </Button>
      }
    >
      {props.children}
    </PrSection>
  );
}

function GlanceRows(props: { files: GlanceFile[]; onOpenCode(path?: string): void }) {
  return (
    <ul>
      {props.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            title={file.path}
            onClick={() => props.onOpenCode(file.path)}
            className={cn(
              plainRow,
              "flex min-h-7 w-full items-center gap-3 px-1.5 text-left focus-ring-inset",
            )}
          >
            <span className="flex min-w-0 flex-1 font-mono text-xs">
              {file.directory && (
                <span className="min-w-0 truncate text-subtle-foreground [direction:rtl]">
                  <bdi>{file.directory}</bdi>
                </span>
              )}
              <span className="shrink-0 text-foreground">{file.name}</span>
            </span>
            <MicroBar file={file} />
            <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
              <span className="text-status-done">+{file.additions}</span>{" "}
              <span className="text-status-failed">−{file.deletions}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function GlanceFromDetail(props: { detail: ForgePrDetail; onOpenCode(path?: string): void }) {
  const files = biggestFiles(props.detail.files ?? [], shown);
  return (
    <GlanceFrame detail={props.detail} onOpenCode={props.onOpenCode}>
      {files.length ? (
        <GlanceRows files={files} onOpenCode={props.onOpenCode} />
      ) : (
        <p className="text-ui text-muted-foreground">No changed files.</p>
      )}
    </GlanceFrame>
  );
}

function GlanceFromPages(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onOpenCode(path?: string): void;
}) {
  const pages = usePrFilePages({
    workspaceId: props.workspaceId,
    repository: props.detail.status.ref.repository,
    detail: props.detail,
    commit: "",
  });
  const files = biggestFiles(pages.range?.files ?? [], shown);
  return (
    <GlanceFrame detail={props.detail} onOpenCode={props.onOpenCode}>
      {pages.error ? (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          {readFailureText(pages.error)}
          <Button size="xs" onClick={pages.retry}>
            Retry
          </Button>
        </p>
      ) : pages.pending ? (
        <LoadingRegion label="changed files">
          <ul aria-hidden>
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex h-7 items-center gap-3 px-1.5">
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-1.5 w-16 rounded-full @max-[30rem]/pr:hidden" />
                <Skeleton className="h-3 w-20" />
              </li>
            ))}
          </ul>
        </LoadingRegion>
      ) : files.length ? (
        <GlanceRows files={files} onOpenCode={props.onOpenCode} />
      ) : (
        <p className="text-ui text-muted-foreground">No changed files.</p>
      )}
    </GlanceFrame>
  );
}
