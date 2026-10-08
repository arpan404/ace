import { lazy, Suspense } from "react";
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
  stream?: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <Suspense fallback={<MarkdownLoading text={props.text} className={props.className} />}>
      <Markdown
        text={props.text}
        stream={props.stream}
        streaming={props.streaming}
        className={props.className}
      />
    </Suspense>
  );
}
