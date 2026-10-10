// oxlint-disable react/no-array-index-key -- text tokens have no identity; their position is it.
import type { CSSProperties } from "react";
import type { CodeToken, TokenKind } from "./highlight.ts";

/** Plain fallback while the worker loads a grammar; colored tokens carry both theme schemes. */
export const tokenTone: Record<TokenKind, string> = {
  plain: "",
  keyword: "font-medium text-foreground",
  string: "text-muted-foreground",
  number: "text-muted-foreground",
  comment: "text-subtle-foreground italic",
  punct: "text-muted-foreground",
};

export function CodeTokens(props: { tokens: readonly CodeToken[] }) {
  return props.tokens.map((token, index) => (
    <span
      key={index}
      className={
        token.light && token.dark
          ? "text-[var(--source-token-light)] dark:text-[var(--source-token-dark)]"
          : tokenTone[token.kind]
      }
      style={
        token.light && token.dark
          ? ({
              "--source-token-light": token.light,
              "--source-token-dark": token.dark,
            } as CSSProperties)
          : undefined
      }
    >
      {token.text}
    </span>
  ));
}
