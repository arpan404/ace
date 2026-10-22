import type { Token, Tokens } from "marked";
import type { ReactNode } from "react";

/**
 * What a feature draws in place of the renderer's defaults, for text that isn't agent prose
 * (forge text: ADR 0096). Agent prose passes none, so its rendering is untouched. Each hook gets
 * the lexer's tokens and a way to draw the ones it leaves to the renderer.
 */
export interface MarkdownExtensions {
  /**
   * A run of sibling blocks that holds raw HTML. `render` draws one of them as the renderer
   * would (by its index in `tokens`), keyed.
   */
  blocks(tokens: readonly Token[], render: (index: number) => ReactNode): ReactNode;
  /** A run of inline tokens that holds raw HTML, likewise. */
  inlines(tokens: readonly Token[], render: (index: number) => ReactNode): ReactNode;
  /** `![alt](href)`. */
  image(href: string, alt: string): ReactNode;
  /** A blockquote; `blocks` draws block tokens as the renderer would. Undefined: the default. */
  blockquote(
    token: Tokens.Blockquote,
    blocks: (tokens: readonly Token[]) => ReactNode,
  ): ReactNode | undefined;
  /** A paragraph; `standard` draws it as the renderer would. Undefined: the default. */
  paragraph(token: Tokens.Paragraph, standard: () => ReactNode): ReactNode | undefined;
  /** A fenced code block; `standard` draws it as the renderer would. Undefined: the default. */
  code(token: Tokens.Code, standard: () => ReactNode): ReactNode | undefined;
  /** A task list's checkbox. */
  checkbox(token: Tokens.Checkbox): ReactNode;
  /**
   * Called once each time the document renders, before any of its blocks, with its top-level
   * tokens; returns what follows the last block (footnotes). `inline` draws inline tokens.
   */
  document(tokens: readonly Token[], inline: (tokens: readonly Token[]) => ReactNode): ReactNode;
}
