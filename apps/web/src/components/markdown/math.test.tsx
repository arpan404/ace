import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

test("agent LaTeX renders as math, not as text with eaten backslashes", async () => {
  const text = [
    "The mean \\(\\mu=2.5\\) with",
    "",
    "\\[ z=\\frac{x-\\mu}{\\sigma}=\\frac{2.3-2.5}{0.2}=-1 \\]",
    "",
    "\\[ P(X<2.3)=P(Z<-1)=\\boxed{0.1587\\approx15.87\\%} \\]",
  ].join("\n");
  const view = render(<Markdown text={text} />);
  await waitFor(() => expect(view.container.querySelectorAll(".katex").length).toBe(3));
  expect(view.container.querySelectorAll(".katex-display").length).toBe(2);
  expect(view.container.querySelectorAll(".mfrac").length).toBeGreaterThan(0);
  expect(view.container.querySelector(".katex-error")).toBeNull();
  expect(view.container.innerHTML).not.toContain("\\(");
  expect(view.container.innerHTML).not.toContain("\\[");
  view.unmount();
});

test("dollar math renders inline and as a display block on one line", async () => {
  const view = render(<Markdown text={"Einstein $E=mc^2$ holds and\n\n$$y = x^2$$\n"} />);
  await waitFor(() => expect(view.container.querySelectorAll(".katex").length).toBe(2));
  expect(view.container.querySelectorAll(".katex-display").length).toBe(1);
  expect(view.container.querySelector(".katex-error")).toBeNull();
  view.unmount();
});

test("currency stays text", async () => {
  const view = render(<Markdown text={"It costs $5 and $10 total"} />);
  await screen.findByText(/costs \$5 and \$10/);
  expect(view.container.querySelector(".katex")).toBeNull();
  expect(view.container.textContent).toContain("$5 and $10");
  view.unmount();
});

test("math inside code spans and code blocks stays literal", async () => {
  const view = render(
    <Markdown text={"Use `$x$` and `\\(y\\)` here.\n\n```\n$x$\n\\(z\\)\n```"} />,
  );
  await screen.findByText("$x$", { selector: "code" });
  await waitFor(() =>
    expect(view.container.querySelectorAll("code").length).toBeGreaterThanOrEqual(2),
  );
  expect(view.container.querySelector(".katex")).toBeNull();
  expect(view.container.textContent).toContain("$x$");
  expect(view.container.textContent).toContain("\\(y\\)");
  view.unmount();
});

test("an unclosed delimiter shows text mid-stream then renders once closed", async () => {
  const stream = "thread/math-unclosed";
  const view = render(<Markdown stream={stream} streaming text={"Result \\[ x+1"} />);
  await screen.findByText(/Result/);
  expect(view.container.querySelector(".katex")).toBeNull();
  expect(view.container.textContent).toContain("\\[ x+1");
  view.rerender(<Markdown stream={stream} streaming text={"Result \\[ x+1 \\]"} />);
  await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull());
  expect(view.container.querySelector(".katex-error")).toBeNull();
  view.rerender(<Markdown stream={stream} text={"Result \\[ x+1 \\]"} />);
  await waitFor(() => expect(view.container.querySelector(".katex-display")).not.toBeNull());
  view.unmount();
});

test("invalid TeX shows its source without throwing", async () => {
  const view = render(<Markdown text={"See \\(\\unknowncommand{\\) done"} />);
  await waitFor(() =>
    expect(view.container.querySelector("code")?.textContent).toBe("\\(\\unknowncommand{\\)"),
  );
  expect(view.container.querySelector(".katex")).toBeNull();
  expect(view.container.querySelector(".katex-error")).toBeNull();
  expect(view.container.innerHTML).not.toContain("cc0000");
  view.unmount();
});

test("streamed math settles into the same output as its whole text", async () => {
  const text = "Mean \\(\\mu=2.5\\).\n\n\\[ z=\\frac{2.3-2.5}{0.2} \\]\n";
  const whole = render(<Markdown text={text} />);
  await waitFor(() => expect(whole.container.querySelectorAll(".katex").length).toBe(2));
  const expected = whole.container.textContent;
  whole.unmount();
  const stream = "thread/math-settle";
  const view = render(<Markdown stream={stream} streaming text={""} />);
  for (let at = 0; at < text.length; at += 7)
    view.rerender(<Markdown stream={stream} streaming text={text.slice(0, at + 7)} />);
  view.rerender(<Markdown stream={stream} text={text} />);
  await waitFor(() => expect(view.container.textContent).toBe(expected));
  expect(view.container.querySelectorAll(".katex").length).toBe(2);
  view.unmount();
});
