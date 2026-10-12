import { lazy, Suspense, type ReactNode } from "react";
import type { MarkdownLinks } from "./link-options.ts";
import { MarkdownLoading } from "./loading.tsx";

// The lexer and renderer load as their own chunk, in parallel with the thread screen, so the
// route stays inside its bundle budget (ADR 0045). A skeleton holds the place until it is ready.
const Markdown = lazy(() =>
  import("./markdown.tsx").then((module) => ({ default: module.Markdown })),
);

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
  return (
    <Suspense fallback={<MarkdownLoading text={props.text} className={props.className} />}>
      <Markdown
        text={props.text}
        links={props.links}
        thread={props.thread}
        stream={props.stream}
        streaming={props.streaming}
        className={props.className}
        tail={props.tail}
      />
    </Suspense>
  );
}
