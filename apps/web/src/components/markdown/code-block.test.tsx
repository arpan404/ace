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
