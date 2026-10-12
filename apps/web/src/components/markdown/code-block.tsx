// oxlint-disable react/no-array-index-key -- lexer tokens have no identity; position is it.
import { useCopy } from "../use-copy.ts";
export { useCopy } from "../use-copy.ts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodeToken } from "./highlight.ts";

import { useCodeLines } from "./use-code-lines.ts";
import { LongRows } from "@/components/virtual-rows.tsx";
import { CodeHeader } from "./code-header.tsx";
import { CodeTokens } from "./code-tokens.tsx";
import { DiffBody } from "./diff-body.tsx";
import { readDiffText } from "@ace/ui-core";
import { fenceDiffCached } from "./diff-fence.ts";
import { fenceInfo } from "./fence-info.ts";
export { tokenTone } from "./code-tokens.tsx";

/** Blocks this long get line numbers; shorter ones read fine without. */
export const numberedFrom = 10;

/** The line numbers beside a fence: one text node, so a long block costs one element. */
function Gutter(props: { lines: number; className: string }) {
  const numbers = useMemo(
    () => Array.from({ length: props.lines }, (_, index) => index + 1).join("\n"),
    [props.lines],
  );
  return (
    <pre
      aria-hidden
      className={`shrink-0 pr-3 pl-3 text-right tabular-nums text-subtle-foreground select-none ${props.className}`}
    >
      {numbers}
    </pre>
  );
}

/**
 * A fenced code block: a header with the file it shows (or its language) and Copy, syntax
 * highlighting below, line numbers once it's long, and a unified-diff view for ```diff fences.
 */
export function CodeBlock(props: {
  code: string;
  /** The fence's info string: a language, a file name, or both. */
  lang?: string | undefined;
  /** Tokens highlighted in the markdown worker; nested blocks highlight here. */
  tokens?: CodeToken[];
  /** Still being written: plain text until it settles, rather than highlighting each update. */
  plain?: boolean;
  tail?: ReactNode;
}) {
  const info = useMemo(() => fenceInfo(props.lang), [props.lang]);
  // A settled diff is parsed once per text; one still being written isn't cached.
  const diff = useMemo(
    () =>
      info.diff
        ? props.plain
          ? readDiffText(props.code)
          : fenceDiffCached(props.code)
        : undefined,
    [info.diff, props.plain, props.code],
  );
  // The first render must not tokenize the whole fence while its worker job is pending.
  const local = useMemo(() => [{ kind: "plain" as const, text: props.code }], [props.code]);
  const lines = useMemo(() => props.code.split("\n"), [props.code]);
  const large =
    lines.length > 400 ||
    props.code.length > 128 * 1024 ||
    lines.some((line) => line.length > 8192);
  const [source, setSource] = useState(false);
  const colored = useCodeLines(props.plain || diff ? undefined : props.code, info.lang);
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
  // Copy reads the text when pressed, so the header doesn't re-render with every streamed line.
  const latest = useRef(props.code);
  useLayoutEffect(() => {
    latest.current = props.code;
  }, [props.code]);
  const onCopy = useCallback(() => copy(latest.current), [copy]);
  const numbered = lines.length >= numberedFrom;
  return (
    <figure className="group/code my-3 overflow-hidden rounded-card bg-code shadow-[inset_0_0_0_1px_var(--border)]">
      <CodeHeader
        file={info.file ?? (diff?.files.length === 1 ? diff.files[0] : undefined)}
        lang={info.lang}
        diff={diff}
        copied={copied}
        onCopy={onCopy}
      >
        {large && !diff && (
          <button
            type="button"
            onClick={() => setSource(!source)}
            className="rounded-sm px-1.5 hover:bg-accent"
          >
            {source ? "Highlighted view" : "Full source"}
          </button>
        )}
      </CodeHeader>
      {diff ? (
        <DiffBody diff={diff} tail={props.tail} />
      ) : large ? (
        source ? (
          <textarea
            aria-label="Full code source"
            readOnly
            value={props.code}
            spellCheck={false}
            className="block h-80 w-full resize-y overflow-auto bg-transparent px-3 py-2 font-mono text-xs whitespace-pre"
          />
        ) : (
          <div
            role="region"
            aria-label="Scrollable code"
            tabIndex={0}
            className="max-h-80 overflow-auto pt-2 pr-3 pb-3 font-mono text-xs leading-5"
          >
            <LongRows
              virtualAbove={400}
              items={lines}
              rowKey={(_, index) => String(index)}
              estimate={20}
              overscan={8}
              render={(line, index) => (
                <div className="flex min-h-5">
                  <span
                    aria-hidden
                    className="w-12 shrink-0 pr-3 text-right tabular-nums text-subtle-foreground select-none"
                  >
                    {index + 1}
                  </span>
                  <code className="whitespace-pre">
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
        <div className="flex font-mono text-xs leading-[1.6]">
          {numbered && <Gutter lines={lines.length} className="pt-2 pb-3" />}
          <pre
            className={`min-w-0 flex-1 overflow-x-auto pt-2 pr-3 pb-3 text-foreground ${numbered ? "" : "pl-3"}`}
          >
            <code>
              <CodeTokens tokens={tokens} />
              {props.tail}
            </code>
          </pre>
        </div>
      )}
    </figure>
  );
}
