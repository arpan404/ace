import { createContext, useContext, useMemo, type ReactNode } from "react";
import { fileLanguage, type DiffLine, type DiffRow } from "@ace/ui-core";
import { useCodeLines } from "@/components/markdown/use-code-lines.ts";
import { CodeTokens } from "@/components/markdown/code-tokens.tsx";
import type { CodeToken } from "@/components/markdown/highlight.ts";

const Tokens = createContext<ReadonlyMap<DiffLine, readonly CodeToken[]>>(new Map());
const Whitespace = createContext(false);

/** Highlight each version in the existing source worker; virtualization draws only visible lines. */
export function DiffCodeScope(props: {
  path: string;
  rows: readonly DiffRow[];
  whitespace?: boolean | undefined;
  children: ReactNode;
}) {
  const old = useMemo(
    () => props.rows.filter((row): row is DiffLine => row.kind !== "fold" && row.kind !== "add"),
    [props.rows],
  );
  const next = useMemo(
    () => props.rows.filter((row): row is DiffLine => row.kind !== "fold" && row.kind !== "del"),
    [props.rows],
  );
  const oldCode = useMemo(() => old.map((line) => line.text).join("\n"), [old]);
  const newCode = useMemo(() => next.map((line) => line.text).join("\n"), [next]);
  const lang = fileLanguage(props.path);
  const oldTokens = useCodeLines(oldCode, lang);
  const newTokens = useCodeLines(newCode, lang);
  const tokens = useMemo(() => {
    const result = new Map<DiffLine, readonly CodeToken[]>();
    old.forEach((line, i) => {
      const lineTokens = oldTokens?.lines[i];
      if (lineTokens) result.set(line, lineTokens);
    });
    next.forEach((line, i) => {
      const lineTokens = newTokens?.lines[i];
      if (lineTokens) result.set(line, lineTokens);
    });
    return result;
  }, [old, next, oldTokens, newTokens]);
  return (
    <Whitespace value={props.whitespace ?? false}>
      <Tokens value={tokens}>{props.children}</Tokens>
    </Whitespace>
  );
}
export function DiffCode(props: { line: DiffLine }) {
  const tokens = useContext(Tokens).get(props.line);
  const whitespace = useContext(Whitespace);
  const show = (text: string) =>
    whitespace ? text.replaceAll(" ", "·").replaceAll("\t", "→   ") : text;
  return tokens ? (
    <CodeTokens
      tokens={whitespace ? tokens.map((token) => ({ ...token, text: show(token.text) })) : tokens}
    />
  ) : (
    show(props.line.text || " ")
  );
}
