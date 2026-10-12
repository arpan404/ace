import { useEffect, useState, type ReactNode } from "react";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";
import type { MarkdownLinks } from "./link-options.ts";
import { loadMarkdown } from "./load.ts";
import { MarkdownLoading } from "./loading.tsx";

type Renderer = Awaited<ReturnType<typeof loadMarkdown>>["Markdown"];

// The lexer and renderer load as their own chunk, so the route stays inside its bundle budget
// (ADR 0045). The thread route starts loading it when it matches, and this module once it runs.
let renderer: Renderer | undefined;
let loading: Promise<Renderer> | undefined;
const load = () =>
  (loading ??= loadMarkdown().then(
    (module) => (renderer = module.Markdown),
    (cause: unknown) => {
      loading = undefined;
      throw cause;
    },
  ));
void load().catch(() => {});

/**
 * Whether the renderer's code has loaded. Until then the caller shows a skeleton and re-renders
 * the moment it arrives. It never suspends: a revealed Suspense boundary waits out React's
 * reveal throttle, which held a thread's first messages as skeletons for a third of a second
 * after their code was there.
 */
function useRendererLoaded(): boolean {
  // Reads module state that changes once, when the code arrives; nothing to memoise.
  "use no memo";
  const [failed, setFailed] = useState<{ cause: unknown }>();
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (renderer) return;
    let live = true;
    load().then(
      () => live && setLoaded(true),
      (cause: unknown) => live && setFailed({ cause }),
    );
    return () => {
      live = false;
    };
  }, []);
  if (failed) throw new DeferredLoadError(failed.cause, () => setFailed(undefined));
  return renderer !== undefined;
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
