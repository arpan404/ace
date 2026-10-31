import { useSyncExternalStore } from "react";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";
import { loadMarkitProse } from "./load.ts";
import { MarkdownLoading } from "./loading.tsx";

type MarkitRenderer = Awaited<ReturnType<typeof loadMarkitProse>>["MarkitProse"];

// The markit renderer loads as its own chunk, so the route stays inside its bundle budget
// (ADR 0045). The thread route starts loading it when it matches, and this module once it runs.
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

/** Whether the markit renderer's code has loaded; same no-suspense contract as before. */
function useMarkitLoaded(): boolean {
  const state = useSyncExternalStore(markitSubscribe, markitStatus, markitStatus);
  if (state === "failed") throw new DeferredLoadError(markitFailure?.cause, markitRetry);
  return state === "ready";
}

/**
 * Agent prose as markdown, with readable live text while the renderer loads. `stream`
 * names a message whose text grows while `streaming`.
 *
 * All prose renders through markit, the shared Rust renderer in `packages/markit`
 * (code, math, tables, streaming).
 */
export function Prose(props: {
  text: string;
  stream?: string;
  streaming?: boolean;
  className?: string;
  thread?: { threadId: string; cwd?: string; itemId?: string };
}) {
  // The renderer is module state that changes once, when its code arrives.
  "use no memo";
  const MarkitProse = useMarkitLoaded() ? markitRenderer : undefined;
  if (!MarkitProse)
    return (
      <MarkdownLoading text={props.text} className={props.className} streaming={props.streaming} />
    );
  return (
    <MarkitProse
      text={props.text}
      stream={props.stream}
      streaming={props.streaming}
      className={props.className}
      thread={props.thread}
    />
  );
}
