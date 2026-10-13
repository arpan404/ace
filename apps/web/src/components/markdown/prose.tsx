import { useSyncExternalStore, type ReactNode } from "react";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";
import type { MarkdownLinks } from "./link-options.ts";
import { loadMarkdown } from "./load.ts";
import { MarkdownLoading } from "./loading.tsx";

type Renderer = Awaited<ReturnType<typeof loadMarkdown>>["Markdown"];

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

/**
 * Agent prose as markdown, with a skeleton while the renderer loads. `stream`
 * names a message whose text grows while `streaming` (see `Markdown`).
 */
export function Prose(props: {
  text: string;
  links?: MarkdownLinks | undefined;
  stream?: string;
  streaming?: boolean;
  className?: string;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string };
}) {
  // The renderer is module state that changes once, when its code arrives.
  "use no memo";
  const Markdown = useRendererLoaded() ? renderer : undefined;
  if (!Markdown) return <MarkdownLoading text={props.text} className={props.className} />;
  return (
    <Markdown
      text={props.text}
      links={props.links}
      thread={props.thread}
      stream={props.stream}
      streaming={props.streaming}
      className={props.className}
      tail={props.tail}
    />
  );
}
