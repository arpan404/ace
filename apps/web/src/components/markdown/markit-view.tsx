import { markitLinkTarget, markitWorkerPath } from "@ace/markit-web";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { applePlatform } from "@/lib/keymap.ts";
import { asksForSystemBrowser, type LinkClick } from "@/lib/web-links.ts";
import { cn } from "@/lib/cn.ts";
import { prefersReducedMotion } from "@/lib/motion.ts";
import { updateInterval } from "./cadence.ts";
import {
  answerContext,
  createKeptAnswer,
  disposeKeptAnswer,
  sweepKeptAnswers,
  type AnswerScope,
  type KeptAnswer,
  type KeptAnswers,
  type RendererHooks,
} from "./kept-answers.ts";
import { renderMermaid } from "./mermaid-render.ts";
import { blockRhythm } from "./rhythm.ts";
import { StreamPace } from "./stream-pace.ts";

export interface MarkitCallbacks {
  onLink: (url: string) => void;
  /** A web link clicked to open in the system's browser (⌘/Ctrl or middle click). */
  onSystemLink: (url: string, click: LinkClick) => void;
  onReference: (reference: { kind: string; target: string }) => void;
  resolveImage: (url: string, alt: string, signal: AbortSignal) => Promise<Blob | null>;
  /** After markit draws: the element it drew into, and whether that text was the final one. */
  drawn?: ((element: HTMLElement, finalized: boolean) => void) | undefined;
  /** Subscribes `refresh` to whenever images still without bytes may have them now. */
  watchImages?: ((refresh: () => void) => () => void) | undefined;
}

/** The scheme the theme provider put on the page, for a diagram drawn now. */
const pageScheme = (): "light" | "dark" =>
  document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
/** DESIGN.md code blocks: line numbers from 10 lines, folded to 20 past 22. */
const codeChrome = { lineNumbersFrom: 10, collapseAfter: 20 };

/** Applied renders sampled for tools/web-perf, mirroring the old markdown service's samples. */
const perfSamples = (): Array<{ stream: string; chars: number; ms: number }> | undefined => {
  const perf: unknown = Reflect.get(globalThis, "acePerf");
  return typeof perf === "object" && perf !== null && "markit" in perf && Array.isArray(perf.markit)
    ? (perf.markit as Array<{ stream: string; chars: number; ms: number }>)
    : undefined;
};

/**
 * Each answer's last measured height, read without a layout pass when its row goes: a later
 * mount that has to draw again holds that height, so the rows under it never move.
 */
const heights = new WeakMap<Element, number>();
let sizer: ResizeObserver | undefined;
function watchHeight(node: Element): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  sizer ??= new ResizeObserver((entries) => {
    for (const entry of entries)
      heights.set(entry.target, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
  });
  sizer.observe(node);
  return () => sizer?.unobserve(node);
}

/** Where a thread answer may be kept: its client's kept answers, its item, and what it resolves against. */
export interface KeepTarget {
  answers: KeptAnswers;
  scope: AnswerScope;
  cwd: string | undefined;
  root: string | undefined;
}

/**
 * One markit renderer for one element; text updates stream through it, never React state. A
 * finished thread answer's renderer outlives its row (`kept-answers.ts`): mounting the same
 * answer again in the same context puts the drawing back before the first paint.
 */
export function MarkitView(props: {
  markdown: string;
  finalized: boolean;
  stream: string;
  className?: string | undefined;
  callbacks: MarkitCallbacks;
  flavor: "agent" | "github";
  /** Absent: never kept (prose outside a thread item). */
  keep?: KeepTarget | undefined;
}) {
  const { markdown, finalized, stream, flavor, keep } = props;
  /** The context markit would draw `text` under now. */
  const contextOf = (target: KeepTarget, text: string) =>
    answerContext({ flavor, scheme: pageScheme(), cwd: target.cwd, root: target.root, text });
  // The first frame: the kept drawing when there is one. Otherwise the message reads as plain
  // text until markit's first render replaces it, so an answer is never blank (not while the
  // worker starts, nor if it cannot run at all), held at its last drawn height.
  const [start] = useState(() => {
    const context = keep && finalized ? contextOf(keep, markdown) : undefined;
    if (!keep || context === undefined) return { kept: false, height: undefined };
    return keep.answers.has(keep.scope, context)
      ? { kept: true, height: undefined }
      : { kept: false, height: keep.answers.height(keep.scope, context) };
  });
  const [drawn, setDrawn] = useState(start.kept);
  const drawnRef = useRef(start.kept);
  const wrapper = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const answer = useRef<KeptAnswer | undefined>(undefined);
  /** What the current renderer has on screen, and the context that drew it. */
  const shown = useRef<{ text: string; finalized: boolean; context: string } | undefined>(
    undefined,
  );
  const latest = useRef({ markdown, stream, keep, contextOf, callbacks: props.callbacks });
  useLayoutEffect(() => {
    latest.current = { markdown, stream, keep, contextOf, callbacks: props.callbacks };
  });
  // Stable hooks that call the newest callbacks, whichever renderer is drawing.
  const [hooks] = useState<RendererHooks>(() => ({
    onLink: (url: string) => latest.current.callbacks.onLink(url),
    onReference: (reference: { kind: string; target: string }) =>
      latest.current.callbacks.onReference(reference),
    resolveImage: (url: string, alt: string, signal: AbortSignal) =>
      latest.current.callbacks.resolveImage(url, alt, signal),
    renderDiagram: (language: string, source: string) =>
      language === "mermaid" ? renderMermaid(source, pageScheme()) : null,
  }));

  // Before paint: the kept drawing of this answer, or a fresh renderer.
  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const { markdown: text, keep: target } = latest.current;
    const context = target ? latest.current.contextOf(target, text) : undefined;
    // Every client's records of threads they no longer hold go first, here and at unmount.
    sweepKeptAnswers();
    // Taken whether or not the first frame expected it: a drawing under another context is
    // dropped here, so a stale one never stays kept beside the new.
    const kept =
      target && context !== undefined ? target.answers.take(target.scope, context) : undefined;
    const current =
      kept ?? createKeptAnswer({ workerURL: markitWorkerPath(), flavor, code: codeChrome }, hooks);
    current.hooks.current = hooks;
    parent.append(current.element);
    answer.current = current;
    shown.current = kept && context !== undefined ? { text, finalized: true, context } : undefined;
    if (kept && !drawnRef.current) {
      // Kept after this view's first render was decided: shown before paint all the same.
      drawnRef.current = true;
      setDrawn(true);
    }
    if (kept) {
      // Images whose bytes came while the answer was away, and file mentions whose lookup was
      // cut short when it left: this view finishes them, without drawing the markdown again.
      current.renderer.refreshImages();
      latest.current.callbacks.drawn?.(current.element, true);
    } else if (drawnRef.current) {
      // Another view took it in the meantime: draw again, from the text.
      drawnRef.current = false;
      setDrawn(false);
    }
    const node = wrapper.current;
    const unwatch = node ? watchHeight(node) : () => {};
    return () => {
      unwatch();
      answer.current = undefined;
      const { markdown: lastText, keep: lastTarget } = latest.current;
      const done = shown.current;
      shown.current = undefined;
      // Kept under the context that drew it, never the one current at unmount.
      if (lastTarget && done?.finalized && done.text === lastText)
        lastTarget.answers.keep(
          lastTarget.scope,
          done.context,
          current,
          (node && heights.get(node)) ?? 0,
        );
      else disposeKeptAnswer(current);
      sweepKeptAnswers();
    };
  }, [flavor, hooks]);

  // A streaming message reaches markit 10 to 20 times a second, like the previous renderer
  // (`cadence.ts`): each update can grow the row, which re-measures and re-follows the transcript.
  const pace = useRef<StreamPace | undefined>(undefined);
  useEffect(() => {
    const paced = new StreamPace({
      now: () => performance.now(),
      schedule(delayMs, run) {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      interval: (lastMs) => updateInterval(lastMs, prefersReducedMotion()),
      send(text, done) {
        const current = answer.current;
        const was = shown.current;
        // A kept drawing of this very text is already on screen.
        if (!current || (was && was.text === text && was.finalized === done))
          return Promise.resolve();
        // The context this drawing is made under, recorded as it is asked for.
        const target = latest.current.keep;
        const context = target ? latest.current.contextOf(target, text) : "";
        const started = performance.now();
        return current.renderer.render(text, { finalized: done }).then(
          (patch) => {
            if (patch.superseded || answer.current !== current) return;
            shown.current = { text, finalized: done, context };
            // markit drew in an animation frame, before paint; the placeholder goes in the
            // same turn, or one frame would show the text twice.
            if (!drawnRef.current) {
              drawnRef.current = true;
              flushSync(() => setDrawn(true));
            }
            latest.current.callbacks.drawn?.(current.element, done);
            if (import.meta.env.MODE !== "perf") return;
            perfSamples()?.push({
              stream: latest.current.stream,
              chars: text.length,
              ms: performance.now() - started,
            });
          },
          // The text stays readable; a later update tries again.
          () => {},
        );
      },
    });
    pace.current = paced;
    return () => {
      paced.dispose();
      if (pace.current === paced) pace.current = undefined;
    };
  }, []);
  useEffect(() => {
    pace.current?.push(markdown, finalized);
  }, [markdown, finalized]);
  const { watchImages } = props.callbacks;
  useEffect(() => watchImages?.(() => answer.current?.renderer.refreshImages()), [watchImages]);
  // markit hands every plain click on a link to `onLink`, without the click. A ⌘/Ctrl or middle
  // click on a web link is taken here first (capture runs before markit's listener) and opens
  // in the system's browser, as `WebLink` does.
  const { onSystemLink } = props.callbacks;
  const systemClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!(event.target instanceof Element) || !asksForSystemBrowser(event, applePlatform)) return;
      const href = event.target.closest("a[href]")?.getAttribute("href");
      const target = href ? markitLinkTarget(href) : undefined;
      if (target?.kind !== "web") return;
      event.preventDefault();
      event.stopPropagation();
      onSystemLink(target.href, event);
    },
    [onSystemLink],
  );
  return (
    <div
      ref={wrapper}
      className={cn("markit-ace", blockRhythm, props.className)}
      style={!drawn && start.height ? { minHeight: start.height } : undefined}
      onClickCapture={systemClick}
      onAuxClickCapture={systemClick}
    >
      {!drawn && <p className="whitespace-pre-wrap">{markdown}</p>}
      <div ref={host} />
    </div>
  );
}
