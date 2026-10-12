import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodeBlock } from "./code-block.tsx";

const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const computedStyle = getComputedStyle;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("aria-label") === "Scrollable code" ? 320 : 20;
    },
  });
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const style = computedStyle(element);
    if (element.getAttribute("aria-label") === "Scrollable code")
      Object.defineProperty(style, "overflowY", { value: "auto", configurable: true });
    return style;
  });
});
afterEach(() => {
  if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
  vi.unstubAllGlobals();
});

test("a large fence has bounded mounted rows and keeps the entire source selectable and copyable", async () => {
  const code = Array.from({ length: 10_000 }, (_, index) => `const line${index} = ${index};`).join(
    "\n",
  );
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<CodeBlock code={code} lang="typescript" />);
  const region = screen.getByRole("region", { name: "Scrollable code" });
  await waitFor(() => expect(region.querySelectorAll("code").length).toBeGreaterThan(0));
  expect(region.querySelectorAll("code").length).toBeLessThan(100);
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
  fireEvent.click(screen.getByRole("button", { name: "Full source" }));
  const source = screen.getByRole("textbox", { name: "Full code source" });
  expect(source).toHaveProperty("value", code);
  expect(view.container.querySelectorAll("span").length).toBeLessThan(100);
});

test("a minified long line stays plain and exact while ordinary lines retain syntax colors", async () => {
  const minified = "const value=42;".repeat(10_000);
  const code = minified + "\nexport const normal = 42;";
  render(<CodeBlock code={code} lang="typescript" />);
  const region = screen.getByRole("region", { name: "Scrollable code" });
  await waitFor(() => expect(region.querySelector('[style*="--source-token-light"]')).toBeTruthy());
  const first = region.querySelector("code");
  expect(first?.textContent).toBe(minified);
  expect(first?.querySelectorAll("span").length).toBeLessThanOrEqual(1);
  fireEvent.click(screen.getByRole("button", { name: "Full source" }));
  expect(screen.getByRole("textbox", { name: "Full code source" })).toHaveProperty("value", code);
});

test("a diff fence reads as a unified diff: changes marked, counted, numbered and copied exactly", async () => {
  const code = [
    "--- a/src/replay.ts",
    "+++ b/src/replay.ts",
    "@@ -3,2 +3,3 @@",
    " const start = 0;",
    "-const end = 1;",
    "+const end = 2;",
    "+const cap = 200;",
  ].join("\n");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<CodeBlock code={code} lang="diff" />);
  const figure = screen.getByRole("figure");
  // The header names the file and the change; no language label stands in for it.
  expect(figure.querySelector("figcaption")?.textContent).toContain("src/replay.ts");
  expect(figure.querySelector("figcaption")?.textContent).toContain("+2");
  expect(figure.querySelector("figcaption")?.textContent).toContain("−1");
  expect([...view.container.querySelectorAll("ins")].map((line) => line.textContent)).toEqual([
    "+const end = 2;",
    "+const cap = 200;",
  ]);
  expect([...view.container.querySelectorAll("del")].map((line) => line.textContent)).toEqual([
    "-const end = 1;",
  ]);
  // Hunk numbers sit beside the lines, outside the code itself.
  const codeText = [...figure.querySelectorAll("code")].map((line) => line.textContent).join("\n");
  expect(codeText).toBe(code);
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
});

test("a long block is numbered beside its code, and its code stays exactly the source", () => {
  const code = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  render(<CodeBlock code={code} lang="ts title=src/lines.ts" />);
  const figure = screen.getByRole("figure");
  expect(figure.querySelector("figcaption")?.textContent).toContain("src/lines.ts");
  expect(figure.querySelector("code")?.textContent).toBe(code);
  const numbers = figure.querySelector("pre[aria-hidden]")?.textContent;
  expect(numbers?.split("\n")).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
});

test("a short block has no line numbers and names its language", () => {
  render(<CodeBlock code={"echo ready"} lang="sh" />);
  const figure = screen.getByRole("figure");
  expect(figure.querySelector("pre[aria-hidden]")).toBeNull();
  expect(figure.querySelector("figcaption")?.textContent).toContain("sh");
});
