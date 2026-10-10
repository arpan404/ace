// oxlint-disable react/no-array-index-key -- lexer tokens have no identity; position is it.
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { highlight, type CodeToken } from "./highlight.ts";

import { useCodeLines } from "./use-code-lines.ts";
import { CodeTokens } from "./code-tokens.tsx";
export { tokenTone } from "./code-tokens.tsx";

/** Copy to the clipboard with a short "Copied" confirmation. */
export function useCopy(): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy(text) {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => setCopied(false),
      );
    },
  };
}

/** A fenced code block: language and Copy in a quiet header, syntax highlighting below. */
export function CodeBlock(props: {
  code: string;
  lang?: string | undefined;
  /** Tokens highlighted in the markdown worker; nested blocks highlight here. */
  tokens?: CodeToken[];
  /** Still being written: plain text until it settles, rather than highlighting each update. */
  plain?: boolean;
  tail?: ReactNode;
}) {
  const local = useMemo(
    () =>
      props.tokens
        ? undefined
        : props.plain
          ? [{ kind: "plain" as const, text: props.code }]
          : highlight(props.code, props.lang),
    [props.tokens, props.plain, props.code, props.lang],
  );
  const colored = useCodeLines(props.plain ? undefined : props.code, props.lang);
  const tokens = useMemo(
    () =>
      colored
        ? colored.lines.flatMap((line, index) =>
            index === 0 ? line : [{ kind: "plain" as const, text: "\n" }, ...line],
          )
        : (props.tokens ?? local ?? []),
    [colored, props.tokens, local],
  );
  const { copied, copy } = useCopy();
  return (
    <figure className="group/code my-3 overflow-hidden rounded-card bg-code shadow-[inset_0_0_0_1px_var(--border)]">
      <figcaption className="flex h-8 items-center gap-2 pr-1.5 pl-3 text-xs text-subtle-foreground">
        <span className="font-mono">{props.lang || "text"}</span>
        <button
          type="button"
          onClick={() => copy(props.code)}
          aria-label={copied ? "Copied" : "Copy code"}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
        >
          {copied ? <CheckIcon aria-hidden size={13} /> : <CopyIcon aria-hidden size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-3 pt-0.5 pb-3 font-mono text-[12.5px] leading-[1.55] text-foreground">
        <code>
          <CodeTokens tokens={tokens} />
          {props.tail}
        </code>
      </pre>
    </figure>
  );
}
