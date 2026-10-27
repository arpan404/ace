import type { RefObject } from "react";
import { CodeIcon } from "@phosphor-icons/react";
import type { ForgeFile } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { DeferredFileDiffBlock, type FileView } from "@/features/panels/index.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { PrFileReview } from "./pr-file-review.tsx";
import { hostedFileStatus } from "./pr-code-model.ts";
import type { DiffMode } from "./pr-code-toolbar.tsx";
import { prFileBody } from "./pr-file-body.tsx";
import type { HostedFileShow } from "@ace/ui-core";
import type { FileSides } from "./pr-file-sides.ts";
import type { PrViewedMark } from "./pr-viewed-marks.ts";

const FileDiffBlock = DeferredFileDiffBlock.Component;

/** How a file whose patch GitHub withheld, or that reads better rendered, is read and shown. */
export interface HostedFileRead {
  show: HostedFileShow;
  /** Markdown or a notebook: drawn rendered unless `source`. */
  rendered: "markdown" | "notebook" | undefined;
  source: boolean;
  onSource(source: boolean): void;
  /** Both sides, once wanted. */
  sides: FileSides | undefined;
  /** The scroller, for reading a file as it nears the viewport. */
  root: RefObject<HTMLElement | null>;
  onWant(): void;
  onRetry(): void;
}

/**
 * One changed file of the pull request: the shared diff block, whose sticky header carries the
 * Viewed mark (and "Changed" when GitHub dismissed it after a push), with its review
 * conversations under their lines and new comments started on any line. Where GitHub withheld the patch, both sides are read
 * and diffed here; images, binaries and rendered documents show in place of the lines.
 */
export function PrCodeFile(props: {
  id: string;
  file: ForgeFile;
  diff: FileDiff | undefined;
  context: PrDiffContext;
  view: FileView;
  onView(next: FileView): void;
  mode: DiffMode;
  wrap: boolean;
  mark: PrViewedMark | undefined;
  read: HostedFileRead;
}) {
  const { file, diff, context, read } = props;
  if (!diff)
    return (
      <div id={props.id} className="flex h-8 items-center px-3.5 text-xs text-subtle-foreground">
        <span dir="rtl" className="min-w-0 truncate text-left">
          <bdi dir="ltr">Preparing {file.path}…</bdi>
        </span>
      </div>
    );
  const rendered = read.source ? undefined : read.rendered;
  const body = prFileBody({ ...read, file, rendered });
  // GitHub counts the lines of every file it lists; files past its list are counted here.
  const counted = file.additions + file.deletions > 0;
  return (
    <PrFileReview file={file} diff={diff} context={context} mode={props.mode}>
      {(comments) => (
        <FileDiffBlock
          id={props.id}
          file={{
            ...diff,
            status: hostedFileStatus(file),
            additions: counted ? file.additions : diff.additions,
            deletions: counted ? file.deletions : diff.deletions,
          }}
          view={props.view}
          onView={props.onView}
          mode={props.mode}
          wrap={props.wrap}
          highlighted={comments.highlighted}
          renderAnnotation={comments.renderAnnotation}
          onComment={comments.onComment}
          onExtend={comments.onExtend}
          selection={comments.selection}
          viewed={props.mark?.checked}
          body={body}
          actions={
            <>
              {read.rendered && (
                <IconButton
                  size="sm"
                  icon={CodeIcon}
                  label={`Show source of ${file.path}`}
                  tip="Show source"
                  pressed={read.source}
                  onClick={() => read.onSource(!read.source)}
                />
              )}
              {props.mark && <ViewedMark path={file.path} mark={props.mark} />}
            </>
          }
        />
      )}
    </PrFileReview>
  );
}

function ViewedMark(props: { path: string; mark: PrViewedMark }) {
  const toast = useToast();
  const { mark } = props;
  return (
    <span className="flex shrink-0 items-center gap-2 pl-2">
      {mark.changed && <span className="text-xs text-status-needs-you">Changed</span>}
      {/* The label names the checkbox (Base UI links it by aria-labelledby, which outranks an
          aria-label), so it carries the path for assistive tech beside the visible "Viewed". */}
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          checked={mark.checked}
          disabled={mark.disabled}
          onCheckedChange={(checked) =>
            void mark
              .change(checked)
              .catch(() => toast.error({ title: "Couldn't save viewed state" }))
          }
        />
        <span aria-hidden>Viewed</span>
        <span className="sr-only">{`Viewed ${props.path}`}</span>
      </label>
    </span>
  );
}
