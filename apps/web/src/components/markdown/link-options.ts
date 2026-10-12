import type { ReactNode } from "react";

/** Feature-specific links operate on lexer text, so code and existing links stay intact. */
export interface MarkdownLinks {
  link(href: string, children: ReactNode): ReactNode | undefined;
  text(text: string): ReactNode;
}
