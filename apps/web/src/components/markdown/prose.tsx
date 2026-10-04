import { lazy, Suspense } from "react";

// The lexer and renderer load as their own chunk, in parallel with the thread screen, so the
// route stays inside its bundle budget (ADR 0045). Until then the text shows as plain prose.
const Markdown = lazy(() =>
  import("./markdown.tsx").then((module) => ({ default: module.Markdown })),
);

/** Agent prose as markdown, with a plain-text first paint while the renderer loads. */
export function Prose(props: { text: string; className?: string }) {
  return (
    <Suspense
      fallback={<p className={`whitespace-pre-wrap ${props.className ?? ""}`}>{props.text}</p>}
    >
      <Markdown text={props.text} {...(props.className ? { className: props.className } : {})} />
    </Suspense>
  );
}
