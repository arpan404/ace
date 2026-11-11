import { spadeMarkup, type SpadeInline } from "@ace/ui-core/spade-chat";
import { memo } from "react";

/* oxlint-disable react/no-array-index-key -- a message's blocks and words never reorder: their place is who they are */

/**
 * A message's words with a chat bubble's light formatting (ADR 0127): paragraphs, lists, code
 * blocks, bold, inline code and links. Anything else shows as written. Links open outside.
 */
export const SpadeBubbleText = memo(function SpadeBubbleText(props: { text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 wrap-break-word">
      {spadeMarkup(props.text).map((block, index) =>
        block.kind === "code" ? (
          <pre
            key={index}
            className="no-scrollbar overflow-x-auto rounded-md bg-code px-2.5 py-2 font-mono text-ui leading-normal shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <code>{block.text}</code>
          </pre>
        ) : block.kind === "list" ? (
          block.ordered ? (
            <ol key={index} className="flex list-decimal flex-col gap-0.5 pl-5">
              {block.items.map((item, at) => (
                <li key={at}>
                  <Inlines inlines={item} />
                </li>
              ))}
            </ol>
          ) : (
            <ul key={index} className="flex list-disc flex-col gap-0.5 pl-5">
              {block.items.map((item, at) => (
                <li key={at}>
                  <Inlines inlines={item} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <p key={index} className="whitespace-pre-wrap">
            <Inlines inlines={block.inlines} />
          </p>
        ),
      )}
    </div>
  );
});

function Inlines(props: { inlines: readonly SpadeInline[] }) {
  return props.inlines.map((inline, index) => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "bold":
        return (
          <strong key={index} className="font-semibold">
            {inline.text}
          </strong>
        );
      case "code":
        return (
          <code key={index} className="rounded-xs bg-fill-strong px-1 font-mono text-ui">
            {inline.text}
          </code>
        );
      case "link":
        return (
          <a
            key={index}
            href={inline.href}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline decoration-border-strong underline-offset-3 hover:decoration-foreground"
          >
            {inline.text}
          </a>
        );
    }
  });
}
