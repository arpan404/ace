/*
 * markit draws an answer's HTML itself, so its code blocks, inline code and links get their
 * Suit parts (docs/design/suit-parts.md) here, after each draw. Elements already named keep
 * their part, so a streaming answer's earlier blocks are left alone.
 */
function name(element: Element, part: string): void {
  if (!element.hasAttribute("data-part")) element.setAttribute("data-part", part);
}

export function nameMarkitParts(root: Element): void {
  // A code block is markit's block around the `pre` (it holds the copy button), else the `pre`.
  for (const block of root.querySelectorAll(".mk-codeblock")) name(block, "code-block");
  for (const pre of root.querySelectorAll("pre"))
    if (!pre.closest(".mk-codeblock")) name(pre, "code-block");
  for (const code of root.querySelectorAll("code"))
    if (!code.closest("pre")) name(code, "inline-code");
  for (const link of root.querySelectorAll("a[href], [role='link']")) name(link, "link");
}
