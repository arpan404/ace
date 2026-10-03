// oxlint-disable react/no-array-index-key -- spans have no identity; position is it.
import { inlineSpans } from "@ace/ui-core";

/** The inline code look shared with agent prose (`features/thread/markdown`). */
export const codeSpanClass = "rounded-[5px] bg-secondary px-[5px] py-px font-mono text-[0.87em]";

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
            {span.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-medium">
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
