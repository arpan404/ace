import type { DiffRow } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import {
  GpuTextView,
  pickRenderer,
  textRendererSupport,
  type TextLine,
} from "@/components/gpu-text/index.ts";
import { useFlag } from "@/lib/flags.ts";

/** Diffs at least this long may use the GPU text renderer (flag `gpuText`). */
const gpuThreshold = 5_000;
const gutter = 6;

/** The renderer for a diff of `rows` rows: the GPU only when flagged, supported and huge. */
export function useDiffRenderer(rows: number): "webgpu" | "webgl2" | "dom" {
  const enabled = useFlag("gpuText");
  const [support, setSupport] = useState<{ webgpu: boolean; webgl2: boolean }>();
  const wanted = enabled && rows >= gpuThreshold;
  useEffect(() => {
    if (wanted) void textRendererSupport().then(setSupport);
  }, [wanted]);
  return pickRenderer({
    lines: rows,
    enabled,
    webgpu: support?.webgpu ?? false,
    webgl2: support?.webgl2 ?? false,
    threshold: gpuThreshold,
  });
}

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

/** A huge file's diff drawn by the GPU, read-only; "Show as text" returns to the DOM view. */
export function GpuDiff(props: {
  path: string;
  rows: readonly DiffRow[];
  renderer: "webgpu" | "webgl2";
  onShowText(): void;
}) {
  const lines = useMemo(() => diffLines(props.rows), [props.rows]);
  return (
    <div>
      <p className="flex h-8 items-center gap-2 px-3.5 font-sans text-xs text-subtle-foreground">
        {lines.length.toLocaleString()} lines, drawn with{" "}
        {props.renderer === "webgpu" ? "WebGPU" : "WebGL"}.
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
        renderer={props.renderer}
        gutterCells={gutter * 2 + 1}
        label={`Diff of ${props.path}, ${lines.length} lines. Use Show as text to read it.`}
        onFail={props.onShowText}
      />
    </div>
  );
}
