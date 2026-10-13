import type { MatcherFunction } from "@testing-library/react";

/**
 * Matches the innermost element whose text reads `pattern`, so a highlighted code line, split
 * into one span per token, is found as the line that holds them (with its line controls).
 */
export function codeText(pattern: RegExp): MatcherFunction {
  const reads = (node: Element) => pattern.test(node.textContent ?? "");
  return (_content, element) =>
    element !== null && reads(element) && !Array.from(element.children).some(reads);
}
