import { useEffect, useMemo, useRef, useState } from "react";
import { acquireAtlas } from "./atlas.ts";
import { themeColors, type TextBackend } from "./backend.ts";
import { layoutFrame, totalHeight, type Metrics, type TextLine } from "./layout.ts";
import { webglBackend } from "./webgl.ts";
import { webgpuBackend } from "./webgpu.ts";

const fontPx = 12;
const lineHeight = 20;

interface Cell {
  family: string;
  /** CSS px, snapped so a cell is a whole number of device pixels (crisp nearest sampling). */
  width: number;
  scale: number;
}
/** The monospace cell of the theme's mono font at this device's pixel ratio. */
function measureCell(): Cell {
  const family =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "monospace";
  const scale = globalThis.devicePixelRatio || 1;
  const context = document.createElement("canvas").getContext("2d");
  if (context) context.font = `${fontPx}px ${family}`;
  const advance = context?.measureText("M").width || 7.2;
  return { family, width: Math.ceil(advance * scale) / scale, scale };
}

/**
 * Very large monospace text drawn by the GPU (ADR 0056): the canvas covers the visible box and
 * redraws only what is in view on scroll, at most once per frame. If the backend cannot start,
 * `onFail` hands the document back to the DOM view. The backend and its GPU resources live as
 * long as the view (new lines only redraw) and are released when it unmounts.
 */
export function GpuTextView(props: {
  lines: readonly TextLine[];
  renderer: "webgpu" | "webgl2";
  gutterCells: number;
  label: string;
  onFail(): void;
}) {
  const { lines, renderer, gutterCells, onFail } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cell] = useState(measureCell);
  const shown = useRef(lines);
  const redraw = useRef<(() => void) | undefined>(undefined);
  const columns = useMemo(
    () => lines.reduce((max, line) => Math.max(max, line.text.length), 0) + gutterCells + 2,
    [lines, gutterCells],
  );
  useEffect(() => {
    const box = scroller.current;
    const surface = canvas.current;
    if (!box || !surface) return;
    let backend: TextBackend | undefined;
    let frame = 0;
    let stopped = false;
    let visible = true;
    let buffer: Float32Array | undefined;
    const metrics: Metrics = { lineHeight, cellWidth: cell.width, gutterCells };
    const glyphs = acquireAtlas({
      fontPx,
      family: cell.family,
      cellWidth: cell.width,
      lineHeight,
      scale: cell.scale,
    });
    const atlas = glyphs.atlas;
    const draw = () => {
      frame = 0;
      if (!backend || stopped || !visible) return;
      const view = {
        scrollTop: box.scrollTop,
        scrollLeft: box.scrollLeft,
        width: box.clientWidth,
        height: box.clientHeight,
      };
      const generation = atlas.generation;
      const glyph = (char: string) => atlas.glyph(char);
      const text = shown.current;
      let laid = layoutFrame(text, view, metrics, glyph, atlas.solid, buffer);
      // The atlas filled up and started over mid-frame: lay out again with fresh glyphs.
      if (atlas.generation !== generation)
        laid = layoutFrame(text, view, metrics, glyph, atlas.solid, laid.quads);
      buffer = laid.quads;
      surface.style.width = `${view.width}px`;
      surface.style.height = `${view.height}px`;
      // The canvas sits over the spacer's top while sticking to the view, adding no height.
      surface.style.marginBottom = `-${view.height}px`;
      backend.draw(laid, { width: view.width, height: view.height, scale: atlas.scale });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current = schedule;
    const recolor = () => {
      backend?.colors(themeColors(box));
      schedule();
    };
    void (async () => {
      try {
        const started =
          renderer === "webgpu"
            ? await webgpuBackend(surface, atlas, () => {
                if (!stopped) onFail();
              })
            : webglBackend(surface, atlas);
        if (stopped) return started.dispose();
        backend = started;
        recolor();
      } catch {
        if (!stopped) onFail();
      }
    })();
    box.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(box);
    // Offscreen views do not draw; they catch up when scrolled back into view.
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) schedule();
    });
    seen.observe(box);
    const theme = new MutationObserver(recolor);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => {
      stopped = true;
      redraw.current = undefined;
      if (frame) cancelAnimationFrame(frame);
      box.removeEventListener("scroll", schedule);
      resize.disconnect();
      seen.disconnect();
      theme.disconnect();
      backend?.dispose();
      backend = undefined;
      glyphs.release();
    };
  }, [renderer, gutterCells, onFail, cell]);
  useEffect(() => {
    shown.current = lines;
    redraw.current?.();
  }, [lines]);
  return (
    <div
      ref={scroller}
      role="img"
      aria-label={props.label}
      className="relative h-[70vh] overflow-auto font-mono text-[12px]"
    >
      <canvas ref={canvas} aria-hidden className="pointer-events-none sticky top-0 left-0 block" />
      <div
        aria-hidden
        style={{
          height: totalHeight(lines.length, { lineHeight, cellWidth: cell.width, gutterCells }),
          width: columns * cell.width,
        }}
      />
    </div>
  );
}
