import type { DiffRow } from "@ace/ui-core";
import { useCallback, useMemo, useState } from "react";
import { GpuTextView, type TextLine } from "@/components/gpu-text/index.ts";

/** Gutter cells per line number. */
const gutter = 6;

const number = (value: number | undefined) =>
  (value === undefined ? "" : String(value)).padStart(gutter - 1);

/** Unified diff rows as GPU text lines: both line numbers in the gutter, bands for changes. */
export function diffLines(rows: readonly DiffRow[]): TextLine[] {
  return rows.map((row): TextLine => {
    if (row.kind === "fold")
      return {
        gutter: "",
        text: row.count === null ? "⋯" : `⋯ ${row.count} unchanged lines`,
        band: "fold",
        ink: "muted",
      };
    const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
    return {
      gutter: `${number(row.old)} ${number(row.new)}`,
      text: `${sign} ${row.text}`,
      band: row.kind === "context" ? "none" : row.kind,
      ink: "plain",
    };
  });
}

/**
 * A huge file's diff drawn by the GPU, read-only; "Show as text" returns to the DOM view. Loaded
 * on demand (the default export), so the renderer never weighs on the thread route.
 */
export default function GpuDiff(props: {
  path: string;
  rows: readonly DiffRow[];
  renderer: "webgpu" | "webgl2";
  onShowText(): void;
}) {
  const lines = useMemo(() => diffLines(props.rows), [props.rows]);
  // WebGPU that cannot present falls back to WebGL2, and WebGL2 to the DOM view.
  const [downgraded, setDowngraded] = useState(false);
  const renderer = downgraded ? "webgl2" : props.renderer;
  const { onShowText } = props;
  const fail = useCallback(() => {
    if (renderer === "webgpu") setDowngraded(true);
    else onShowText();
  }, [renderer, onShowText]);
  return (
    <div>
      <p className="flex h-8 items-center gap-2 px-3.5 font-sans text-xs text-subtle-foreground">
        {lines.length.toLocaleString()} lines, drawn with{" "}
        {renderer === "webgpu" ? "WebGPU" : "WebGL"}.
        <button
          type="button"
          onClick={props.onShowText}
          className="ml-auto rounded-sm px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Show as text
        </button>
      </p>
      <GpuTextView
        lines={lines}
        key={renderer}
        renderer={renderer}
        gutterCells={gutter * 2 + 1}
        label={`Diff of ${props.path}, ${lines.length} lines. Use Show as text to read it.`}
        onFail={fail}
      />
    </div>
  );
}
