import { useMemo, type ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { LongRows } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import {
  blockDiff,
  cellKey,
  markdownBlocks,
  notebookCells,
  type NotebookCell,
  type RenderedChange,
} from "@ace/ui-core";

/** Past this many blocks only those near the viewport mount. */
const virtualAbove = 200;

const marks = {
  same: { tone: "", glyph: "", label: "" },
  del: { tone: "bg-diff-del", glyph: "−", label: "Removed" },
  add: { tone: "bg-diff-add", glyph: "+", label: "Added" },
};

/** One block of a rendered diff, tinted and marked (a glyph and a word for assistive tech). */
function Block(props: { kind: RenderedChange<unknown>["kind"]; children: ReactNode }) {
  const mark = marks[props.kind];
  return (
    <div className={cn("relative flex min-w-0 gap-2 py-1 pr-4 pl-3.5", mark.tone)}>
      <span
        aria-hidden
        className="w-3 shrink-0 font-mono text-xs leading-6 text-subtle-foreground select-none"
      >
        {mark.glyph}
      </span>
      {mark.label && <span className="sr-only">{mark.label}:</span>}
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function Rows<T>(props: {
  changes: readonly RenderedChange<T>[];
  render(item: T): ReactNode;
  label: string;
}) {
  return (
    <div role="group" aria-label={props.label} className="py-2 text-sm">
      <LongRows
        items={props.changes}
        virtualAbove={virtualAbove}
        rowKey={(_, index) => String(index)}
        estimate={48}
        render={(change) => <Block kind={change.kind}>{props.render(change.item)}</Block>}
      />
    </div>
  );
}

function MarkdownDiff(props: { path: string; before: string; after: string }) {
  const changes = useMemo(
    () => blockDiff(markdownBlocks(props.before), markdownBlocks(props.after), (block) => block),
    [props.before, props.after],
  );
  return (
    <Rows
      label={`Rendered changes to ${props.path}`}
      changes={changes}
      render={(block) => <Prose text={block} />}
    />
  );
}

/** Source as a fenced code block whose fence is longer than any run of backticks inside. */
function fenced(source: string, language: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

function Cell(props: { cell: NotebookCell; language: string }) {
  const { cell } = props;
  return (
    <div className="space-y-1.5">
      {cell.kind === "markdown" ? (
        <Prose text={cell.source} />
      ) : (
        <Prose text={fenced(cell.source, cell.kind === "code" ? props.language : "")} />
      )}
      {cell.outputs.map((output, index) =>
        output.kind === "image" ? (
          // oxlint-disable-next-line react/no-array-index-key -- outputs have no identity.
          <img key={index} src={output.url} alt="Cell output" className="max-h-96 max-w-full" />
        ) : (
          <pre
            // oxlint-disable-next-line react/no-array-index-key -- outputs have no identity.
            key={index}
            className={cn(
              "max-h-80 overflow-auto rounded-md bg-code px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap",
              output.error ? "text-status-failed" : "text-muted-foreground",
            )}
          >
            {output.text}
          </pre>
        ),
      )}
    </div>
  );
}

function NotebookDiff(props: { path: string; before: string; after: string }) {
  const parsed = useMemo(() => {
    const before = props.before ? notebookCells(props.before) : { language: "", cells: [] };
    const after = props.after ? notebookCells(props.after) : { language: "", cells: [] };
    if (!before || !after) return undefined;
    return {
      language: after.language || before.language,
      changes: blockDiff(before.cells, after.cells, cellKey),
    };
  }, [props.before, props.after]);
  if (!parsed)
    return (
      <p className="px-3.5 py-2 text-xs text-subtle-foreground">
        This notebook couldn't be read. Show its source to see the change.
      </p>
    );
  return (
    <Rows
      label={`Rendered changes to ${props.path}`}
      changes={parsed.changes}
      render={(cell) => <Cell cell={cell} language={parsed.language} />}
    />
  );
}

/**
 * A markdown document or Jupyter notebook drawn as it reads, with each block (or cell) that was
 * removed or added tinted and marked. Unchanged blocks stay, so the change reads in place.
 */
export function PrRenderedDiff(props: {
  kind: "markdown" | "notebook";
  path: string;
  before: string | null;
  after: string | null;
}) {
  const before = props.before ?? "";
  const after = props.after ?? "";
  return props.kind === "markdown" ? (
    <MarkdownDiff path={props.path} before={before} after={after} />
  ) : (
    <NotebookDiff path={props.path} before={before} after={after} />
  );
}
