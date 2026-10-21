// oxlint-disable react/no-array-index-key -- spans have no identity; position is it.
import { inlineSpans } from "@ace/ui-core";
import { Fragment, type ReactNode } from "react";

/**
 * The inline code look shared with agent prose (`features/thread/markdown`). A span that wraps
 * keeps its padding and rounded ends on every line, so it reads as one span, not cut-off pieces.
 */
export const codeSpanClass =
  "rounded-xs bg-code px-1 py-px font-mono text-[0.92em] wrap-break-word box-decoration-clone";

/**
 * Inline code text that, when it must wrap, breaks after a `/` before it breaks mid-name:
 * a long path splits between folders. `<wbr>` adds no characters, so copying is unchanged.
 */
export function CodeText(props: { text: string }): ReactNode {
  const parts = props.text.split("/");
  if (parts.length === 1) return props.text;
  return parts.map((part, index) =>
    index === parts.length - 1 ? (
      part
    ) : (
      <Fragment key={index}>
        {part}/<wbr />
      </Fragment>
    ),
  );
}

/**
 * Short text people or agents wrote (line comments, questions, options) with its `code`,
 * **strong** and *emphasis* rendered. Never injects HTML; for full messages use agent prose.
 */
export function InlineMarkdown(props: { text: string }) {
  return inlineSpans(props.text).map((span, index) => {
    switch (span.kind) {
      case "code":
        return (
          <code key={index} className={codeSpanClass}>
            <CodeText text={span.text} />
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            {span.text}
          </strong>
        );
      case "em":
        return <em key={index}>{span.text}</em>;
      case "text":
        return span.text;
    }
  });
}
