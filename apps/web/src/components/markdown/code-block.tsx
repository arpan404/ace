// oxlint-disable react/no-array-index-key -- lexer tokens have no identity; position is it.
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import type { CodeToken } from "./highlight.ts";

import { useCodeLines } from "./use-code-lines.ts";
import { LongRows } from "@/components/virtual-rows.tsx";
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
  // The first render must not tokenize the whole fence while its worker job is pending.
  const local = useMemo(() => [{ kind: "plain" as const, text: props.code }], [props.code]);
  const lines = useMemo(() => props.code.split("\n"), [props.code]);
  const large =
    lines.length > 400 ||
    props.code.length > 128 * 1024 ||
    lines.some((line) => line.length > 8192);
  const [source, setSource] = useState(false);
  const colored = useCodeLines(props.plain ? undefined : props.code, props.lang);
  const tokens = useMemo(
    () =>
      colored && !large && colored.lines.reduce((count, line) => count + line.length, 0) <= 4096
        ? colored.lines.flatMap((line, index) =>
            index === 0 ? line : [{ kind: "plain" as const, text: "\n" }, ...line],
          )
        : props.tokens && props.tokens.length <= 4096
          ? props.tokens
          : local,
    [colored, props.tokens, local, large],
  );
  const { copied, copy } = useCopy();
  return (
    <figure className="group/code my-3 overflow-hidden rounded-card bg-code shadow-[inset_0_0_0_1px_var(--border)]">
      <figcaption className="flex h-8 items-center gap-2 pr-1.5 pl-3 text-xs text-subtle-foreground">
        <span className="font-mono">{props.lang || "text"}</span>
        {large && (
          <button
            type="button"
            onClick={() => setSource(!source)}
            className="ml-auto rounded-sm px-1.5 hover:bg-accent"
          >
            {source ? "Highlighted view" : "Full source"}
          </button>
        )}
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
      {large ? (
        source ? (
          <textarea
            aria-label="Full code source"
            readOnly
            value={props.code}
            spellCheck={false}
            className="block h-80 w-full resize-y overflow-auto bg-transparent px-3 pb-3 font-mono text-xs whitespace-pre"
          />
        ) : (
          <div
            role="region"
            aria-label="Scrollable code"
            tabIndex={0}
            className="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs leading-5"
          >
            <LongRows
              virtualAbove={400}
              items={lines}
              rowKey={(_, index) => String(index)}
              estimate={20}
              overscan={8}
              render={(line, index) => (
                <div className="min-h-5 whitespace-pre">
                  <code>
                    {line.length <= 8192 &&
                    colored?.lines[index] &&
                    colored.lines[index].length <= 512 ? (
                      <CodeTokens tokens={colored.lines[index]} />
                    ) : (
                      line || "\u00a0"
                    )}
                  </code>
                </div>
              )}
            />
            {props.tail}
          </div>
        )
      ) : (
        <pre className="overflow-x-auto px-3 pt-0.5 pb-3 font-mono text-[12.5px] leading-[1.55] text-foreground">
          <code>
            <CodeTokens tokens={tokens} />
            {props.tail}
          </code>
        </pre>
      )}
    </figure>
  );
}
