import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";

/* A Markdown file's source is Markdown: coloured by markit, and named so in the status line. */

const coloured = () =>
  document
    .querySelector('[data-line="0"]')
    ?.querySelectorAll('[style*="--source-token-light"]').length ?? 0;

test("README.md opens as coloured Markdown and the status line says Markdown", async () => {
  render(
    <CodeEditor
      path="README.md"
      label="Editor"
      text={"# Title with **bold** and `code`\n"}
      highlightDelay={0}
    />,
  );

  await waitFor(() => expect(coloured()).toBeGreaterThan(1));
  const status = screen.getByRole("contentinfo", { name: "Editor status" });
  expect(status.textContent).toContain("Markdown");
  expect(status.textContent).not.toContain("Plain Text");
});
