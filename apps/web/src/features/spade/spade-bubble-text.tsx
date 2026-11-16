import { spadeMarkup, type SpadeBlock, type SpadeInline } from "@ace/ui-core/spade-chat";
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

/* oxlint-disable react/no-array-index-key -- a message's blocks and words never reorder: their place is who they are */

/** Whose bubble the words sit in: code takes that bubble's well. */
export type BubbleSide = "bot" | "mine";

/**
 * A message's words as a bubble shows them (ADR 0127): paragraphs, headings, lists, quotes,
 * tables and code, with bold, italic, struck text, inline code and links in a line. No mark ever
 * shows as written (`spadeMarkup`). In a bot's bubble a code block sits in the `--chat-code`
 * well, hung 6px in from the bubble's edge, with its language and Copy in a 32px header. Links
 * open outside.
 */
export const SpadeBubbleText = memo(function SpadeBubbleText(props: {
  text: string;
  side?: BubbleSide;
}) {
  const side = props.side ?? "bot";
  return (
    <div className="flex min-w-0 flex-col gap-2.5 wrap-break-word">
      {spadeMarkup(props.text).map((block, index) => (
        <Block key={index} block={block} side={side} />
      ))}
    </div>
  );
});

function Block(props: { block: SpadeBlock; side: BubbleSide }) {
  const { block, side } = props;
  switch (block.kind) {
    case "code":
      return <CodeBlock text={block.text} language={block.language} side={side} />;
    case "heading":
      return (
        <p role="heading" aria-level={3} className="text-base leading-6 font-semibold">
          <Inlines inlines={block.inlines} side={side} />
        </p>
      );
    case "quote":
      return (
        <blockquote
          className={cn(
            "border-l-2 border-current/25 pl-3 whitespace-pre-wrap",
            side === "bot" ? "text-muted-foreground" : "text-chat-mine-meta",
          )}
        >
          <Inlines inlines={block.inlines} side={side} />
        </blockquote>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={cn("flex flex-col gap-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}
        >
          {block.items.map((item, at) => (
            <li key={at}>
              <Inlines inlines={item} side={side} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div className="no-scrollbar -mx-(--chat-code-inset) overflow-x-auto">
          <table className="w-max min-w-full border-collapse text-ui leading-5">
            <thead>
              <tr>
                {block.head.map((cell, at) => (
                  <th
                    key={at}
                    className="border-b border-current/20 px-(--chat-code-inset) pb-1 text-left font-semibold"
                  >
                    <Inlines inlines={cell} side={side} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                <tr key={at}>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className="border-b border-current/10 px-(--chat-code-inset) py-1 align-top"
                    >
                      <Inlines inlines={cell} side={side} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Inlines inlines={block.inlines} side={side} />
        </p>
      );
  }
}

/** How long Copy reads "Copied" after a press. */
const copiedFor = 1500;

/** A code block in its well: the fence's language and Copy above the code, which scrolls. */
function CodeBlock(props: { text: string; language: string | undefined; side: BubbleSide }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(props.text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), copiedFor);
    });
  };
  return (
    <div
      className={cn(
        "-mx-[calc(var(--chat-bubble-x)-var(--chat-code-inset))] overflow-hidden rounded-(--chat-code-radius)",
        props.side === "bot" ? "bg-chat-code" : "bg-chat-mine-code",
      )}
    >
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3">
        <span
          className={cn(
            "truncate text-xs leading-4",
            props.side === "bot" ? "text-subtle-foreground" : "text-chat-mine-meta",
          )}
        >
          {props.language ?? "Code"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={copy}
          className={props.side === "mine" ? "text-current hover:bg-current/10" : undefined}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="no-scrollbar overflow-x-auto px-3 pb-3 font-mono text-[13px] leading-5">
        <code>{props.text}</code>
      </pre>
    </div>
  );
}

function Inlines(props: { inlines: readonly SpadeInline[]; side: BubbleSide }) {
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
      case "italic":
        return <em key={index}>{inline.text}</em>;
      case "strike":
        return <s key={index}>{inline.text}</s>;
      case "code":
        return (
          <code
            key={index}
            className={cn(
              "rounded-xs px-1.5 py-px font-mono text-[0.86em]",
              props.side === "bot" ? "bg-chat-code" : "bg-chat-mine-code",
            )}
          >
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
            className="underline decoration-current/40 underline-offset-3 hover:decoration-current"
          >
            {inline.text}
          </a>
        );
    }
  });
}
