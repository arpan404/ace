import { useSyncExternalStore, type ReactNode } from "react";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";
import type { MarkdownLinks } from "./link-options.ts";
import type { MarkdownExtensions } from "./extensions.ts";
import { loadMarkdown, loadMarkitProse } from "./load.ts";
import { scheduleMathWarmup } from "./math-warm.ts";
import { MarkdownLoading } from "./loading.tsx";

type Renderer = Awaited<ReturnType<typeof loadMarkdown>>["Markdown"];
type MarkitRenderer = Awaited<ReturnType<typeof loadMarkitProse>>["MarkitProse"];

// The lexer and renderer load as their own chunk, so the route stays inside its bundle budget
// (ADR 0045). The thread route starts loading it when it matches, and this module once it runs.
let renderer: Renderer | undefined;
let failure: { cause: unknown } | undefined;
let loading: Promise<unknown> | undefined;
const listeners = new Set<() => void>();
const settle = () => {
  for (const listener of listeners) listener();
};
const load = () =>
  (loading ??= loadMarkdown().then(
    (module) => {
      renderer = module.Markdown;
      // The app is interactive once prose can render; warm KaTeX at idle so
      // the first formula shows with no chunk wait. Never on the critical
      // startup path, mobile, or metered links (see `math-warm.ts`).
      scheduleMathWarmup();
      settle();
    },
    (cause: unknown) => {
      loading = undefined;
      failure = { cause };
      settle();
    },
  ));
void load();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  void load();
  return () => listeners.delete(listener);
};

// The markit renderer loads as its own chunk for the same reason. Agent prose waits for it;
// forge text never loads it.
let markitRenderer: MarkitRenderer | undefined;
let markitFailure: { cause: unknown } | undefined;
let markitLoading: Promise<unknown> | undefined;
const markitListeners = new Set<() => void>();
const markitSettle = () => {
  for (const listener of markitListeners) listener();
};
const markitLoad = () =>
  (markitLoading ??= loadMarkitProse().then(
    (module) => {
      markitRenderer = module.MarkitProse;
      markitSettle();
    },
    (cause: unknown) => {
      markitLoading = undefined;
      markitFailure = { cause };
      markitSettle();
    },
  ));
void markitLoad();
const markitSubscribe = (listener: () => void) => {
  markitListeners.add(listener);
  void markitLoad();
  return () => markitListeners.delete(listener);
};
const markitStatus = () => (markitRenderer ? "ready" : markitFailure ? "failed" : "loading");
/** A boundary's retry after a failed markit load. */
const markitRetry = () => {
  markitFailure = undefined;
  void markitLoad();
  markitSettle();
};
const status = () => (renderer ? "ready" : failure ? "failed" : "loading");
/** A boundary's retry after a failed load: loading again, from the next render. */
const retry = () => {
  failure = undefined;
  void load();
  settle();
};

/**
 * Whether the renderer's code has loaded. Until then the caller shows a skeleton and re-renders
 * the moment it arrives. It never suspends: a revealed Suspense boundary waits out React's
 * reveal throttle, which held a thread's first messages as skeletons for a third of a second
 * after their code was there. A failed load goes to the nearest boundary, which can retry.
 */
function useRendererLoaded(): boolean {
  const state = useSyncExternalStore(subscribe, status, status);
  if (state === "failed") throw new DeferredLoadError(failure?.cause, retry);
  return state === "ready";
}

/** Whether the markit renderer's code has loaded; same no-suspense contract as above. */
function useMarkitLoaded(): boolean {
  const state = useSyncExternalStore(markitSubscribe, markitStatus, markitStatus);
  if (state === "failed") throw new DeferredLoadError(markitFailure?.cause, markitRetry);
  return state === "ready";
}

/**
 * Agent prose as markdown, with readable live text while the renderer loads. `stream`
 * names a message whose text grows while `streaming` (see `Markdown`).
 *
 * Agent prose (no `extensions`, no `links`) renders through markit, the shared Rust
 * renderer in `packages/markit` (code, math, tables, streaming). Forge text keeps the
 * previous renderer with its HTML/media/mermaid extensions.
 */
export function Prose(props: {
  text: string;
  links?: MarkdownLinks | undefined;
  stream?: string;
  streaming?: boolean;
  className?: string;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string };
  /** What a feature draws instead of the defaults (forge text); none for agent prose. */
  extensions?: MarkdownExtensions | undefined;
}) {
  // The renderer is module state that changes once, when its code arrives.
  "use no memo";
  // Vitest (jsdom) has no markit worker/Wasm; keep its suites on the previous renderer.
  // Browsers use markit for agent prose. Forge text always keeps the previous renderer.
  if (import.meta.env.MODE === "test" || props.extensions || props.links)
    return <LegacyProse {...props} />;
  return <AgentProse {...props} />;
}

function AgentProse(props: {
  text: string;
  stream?: string | undefined;
  streaming?: boolean;
  className?: string;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string };
}) {
  // The markit renderer is module state that changes once, when its code arrives.
  const MarkitProse = useMarkitLoaded() ? markitRenderer : undefined;
  if (!MarkitProse)
    return (
      <MarkdownLoading
        text={props.text}
        className={props.className}
        streaming={props.streaming}
        tail={props.tail}
      />
    );
  return (
    <MarkitProse
      text={props.text}
      stream={props.stream}
      streaming={props.streaming}
      className={props.className}
      tail={props.tail}
      thread={props.thread}
    />
  );
}

function LegacyProse(props: {
  text: string;
  links?: MarkdownLinks | undefined;
  stream?: string;
  streaming?: boolean;
  className?: string;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string };
  extensions?: MarkdownExtensions | undefined;
}) {
  const Markdown = useRendererLoaded() ? renderer : undefined;
  if (!Markdown)
    return (
      <MarkdownLoading
        text={props.text}
        className={props.className}
        streaming={props.streaming}
        tail={props.tail}
      />
    );
  return (
    <Markdown
      text={props.text}
      links={props.links}
      thread={props.thread}
      stream={props.stream}
      streaming={props.streaming}
      className={props.className}
      tail={props.tail}
      extensions={props.extensions}
    />
  );
}
