import type { ForgeFile } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { DeferredFileDiffBlock, type FileView } from "@/features/panels/index.ts";
import type { PrDiffContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrFileReview } from "./pr-file-review.tsx";
import { hostedFileStatus } from "./pr-code-model.ts";
import type { DiffMode } from "./pr-code-toolbar.tsx";
import type { PrViewedMark } from "./pr-viewed-marks.ts";

const FileDiffBlock = DeferredFileDiffBlock.Component;

/**
 * One changed file of the pull request: the shared diff block, whose sticky header carries the
 * Viewed mark (and "Changed" when GitHub dismissed it after a push), with comments drafted on
 * GitHub's review or handed to the adapter.
 */
export function PrCodeFile(props: {
  id: string;
  file: ForgeFile;
  diff: FileDiff | undefined;
  context: PrDiffContext;
  extensions: PrWorkspaceExtensions | undefined;
  view: FileView;
  onView(next: FileView): void;
  mode: DiffMode;
  wrap: boolean;
  mark: PrViewedMark | undefined;
}) {
  const { file, diff, context, extensions } = props;
  if (!diff)
    return (
      <div id={props.id} className="flex h-8 items-center px-3.5 text-xs text-subtle-foreground">
        <span dir="rtl" className="min-w-0 truncate text-left">
          <bdi dir="ltr">Preparing {file.path}…</bdi>
        </span>
      </div>
    );
  return (
    <PrFileReview file={file} context={context}>
      {(native) => (
        <FileDiffBlock
          id={props.id}
          file={{
            ...diff,
            status: hostedFileStatus(file),
            additions: file.additions,
            deletions: file.deletions,
          }}
          view={props.view}
          onView={props.onView}
          mode={props.mode}
          wrap={props.wrap}
          highlighted={() => false}
          renderAnnotation={(target) => extensions?.annotation?.(file.path, target, context)}
          onComment={
            extensions?.onLineComment
              ? context.disabled
                ? undefined
                : (range) => extensions.onLineComment?.(file.path, range, context)
              : native.onComment
          }
          viewed={props.mark?.checked}
          actions={props.mark && <ViewedMark path={file.path} mark={props.mark} />}
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
