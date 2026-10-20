import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "katex";
import { afterEach, expect, test } from "vitest";
import { setMathRenderer } from "./math-cache.ts";
import { loadMath, setMathLoader } from "./math-load.ts";
import { Markdown } from "./markdown.tsx";

afterEach(() => {
  setMathLoader(undefined);
  setMathRenderer(undefined);
});

test("a formula whose KaTeX load failed reads as prose and renders once a later load succeeds", async () => {
  setMathRenderer(undefined);
  let online = false;
  setMathLoader(async () => {
    if (!online) throw new Error("Failed to fetch dynamically imported module");
    setMathRenderer(renderToString);
  });
  const view = render(<Markdown text={"Takes expected \\(O(k)\\) time"} />);
  await screen.findByText(/Takes expected/);
  // The failed load leaves the source as ordinary prose, never a code span.
  await act(() => loadMath());
  expect(view.container.textContent).toBe("Takes expected \\(O(k)\\) time");
  expect(view.container.querySelector("code")).toBeNull();
  expect(view.container.querySelector("math")).toBeNull();
  // The next load (a warm-up, another formula mounting) succeeds and heals it.
  online = true;
  await act(() => loadMath());
  await waitFor(() => expect(view.container.querySelector("math")).not.toBeNull());
  expect(view.container.querySelector("annotation")?.textContent).toBe("O(k)");
  view.unmount();
});
