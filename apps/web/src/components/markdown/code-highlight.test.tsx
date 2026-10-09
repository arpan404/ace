import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { CodeBlock } from "./code-block.tsx";

test("a streamed fenced block gains theme-aware Shiki colors when it settles and preserves its text", async () => {
  const code = 'export const App = () => <button title="Hello">{42}</button>;\n// end\n';
  const view = render(<CodeBlock code={code} lang="tsx" plain />);
  const figure = screen.getByRole("figure");
  expect(figure.querySelectorAll('[style*="--source-token-light"]').length).toBe(0);
  view.rerender(<CodeBlock code={code} lang="tsx" plain={false} />);
  await waitFor(() => {
    const tokens = figure.querySelectorAll<HTMLElement>('[style*="--source-token-light"]');
    expect(
      new Set([...tokens].map((token) => token.style.getPropertyValue("--source-token-light")))
        .size,
    ).toBeGreaterThan(3);
    expect(
      new Set([...tokens].map((token) => token.style.getPropertyValue("--source-token-dark"))).size,
    ).toBeGreaterThan(3);
  });
  expect(figure.querySelector("code")?.textContent).toBe(code);
  // Theme changes reuse these variants rather than waiting for another grammar/worker job.
  expect(figure.querySelector('[style*="--source-token-dark"]')?.className).toContain("dark:text-");
});

test("an unrecognized fenced language remains readable with unchanged whitespace", () => {
  const code = "  <not-html>\n  & characters\n";
  render(<CodeBlock code={code} lang="unknown-language" />);
  expect(screen.getByRole("figure").querySelector("code")?.textContent).toBe(code);
  expect(document.querySelector("not-html")).toBeNull();
});
