import { useEffect, useState } from "react";
import { pickRenderer } from "@/components/gpu-text/layout.ts";
import { textRendererSupport } from "@/components/gpu-text/support.ts";
import { useFlag } from "@/lib/flags.ts";

/** Diffs at least this long may use the GPU text renderer (flag `gpuText`). */
const gpuThreshold = 5_000;

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
