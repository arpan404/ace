import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { warmMathNow } from "./math-warm.ts";
import { Formula } from "./math.tsx";
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
  // No delimiter is left showing outside the rendered formulas.
  const prose = view.container.cloneNode(true) as HTMLElement;
  for (const formula of prose.querySelectorAll(".katex")) formula.remove();
  expect(prose.textContent).not.toContain("\\(");
  expect(prose.textContent).not.toContain("\\[");
  view.unmount();
});

test("dollar math renders inline and as a display block on one line", async () => {
  const view = render(<Markdown text={"Einstein $E=mc^2$ holds and\n\n$$y = x^2$$\n"} />);
  await waitFor(() => expect(view.container.querySelectorAll(".katex").length).toBe(2));
  expect(view.container.querySelectorAll(".katex-display").length).toBe(1);
  expect(view.container.querySelector(".katex-error")).toBeNull();
  view.unmount();
});

test("inline \\( \\) math renders as math, not code", async () => {
  // The reply that showed raw TeX in a code font (2026-10-19).
  const text =
    "**2) \\(T(n)=2\\cdot3^{n-1}-1\\)**, assuming the recurrence applies for \\(n\\ge2\\). " +
    "Two-sum takes expected \\(O(n)\\) time; sorting takes \\(O(n\\log n)\\).";
  const view = render(<Markdown text={text} />);
  await waitFor(() => expect(view.container.querySelectorAll("math").length).toBe(4));
  expect(view.container.querySelector("strong math")).not.toBeNull();
  expect(view.container.querySelector("code")).toBeNull();
  expect(view.container.querySelector("annotation")?.textContent).toBe("T(n)=2\\cdot3^{n-1}-1");
  view.unmount();
});

test("dollar amounts in prose stay text", async () => {
  const text =
    "It costs $5 and $10, or $5-$10 total. Set $HOME/$USER, run echo $PATH, pay \\$x$ now.";
  const view = render(<Markdown text={text} />);
  await screen.findByText(/costs \$5 and \$10/);
  expect(view.container.querySelector("math")).toBeNull();
  expect(view.container.querySelector(".katex")).toBeNull();
  expect(view.container.textContent).toBe(
    "It costs $5 and $10, or $5-$10 total. Set $HOME/$USER, run echo $PATH, pay $x$ now.",
  );
  view.unmount();
});

test("math inside a code span stays code", async () => {
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

test("an unterminated \\( while streaming renders as text", async () => {
  const stream = "thread/math-unterminated-paren";
  const view = render(<Markdown stream={stream} streaming text={"Two-sum takes \\(O(n"} />);
  await screen.findByText(/Two-sum/);
  expect(view.container.textContent).toBe("Two-sum takes \\(O(n");
  expect(view.container.querySelector("math")).toBeNull();
  expect(view.container.querySelector("code")).toBeNull();
  view.rerender(<Markdown stream={stream} streaming text={"Two-sum takes \\(O(n)\\) time"} />);
  await waitFor(() => expect(view.container.querySelector("math")).not.toBeNull());
  expect(view.container.textContent).toContain(" time");
  view.unmount();
});

test("invalid TeX shows its source", async () => {
  const view = render(<Markdown text={"See \\(\\unknowncommand{\\) done"} />);
  await waitFor(() =>
    expect(view.container.querySelector(".text-muted-foreground")?.textContent).toBe(
      "\\(\\unknowncommand{\\)",
    ),
  );
  expect(view.container.textContent).toBe("See \\(\\unknowncommand{\\) done");
  expect(view.container.querySelector("code")).toBeNull();
  expect(view.container.querySelector(".katex")).toBeNull();
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

test("a warm formula renders in the same commit with no source frame", async () => {
  await warmMathNow();
  const view = render(<Formula raw="\\(n\\)" tex="n" display={false} />);
  expect(view.container.querySelector(".katex")).not.toBeNull();
  expect(view.container.querySelector("code")).toBeNull();
  view.unmount();
});

test("a streamed formula shows rendered math with no source flash once warm", async () => {
  await warmMathNow();
  const stream = "thread/math-warm-commit";
  const view = render(<Markdown stream={stream} streaming text={"Warm \\(w+1\\).\n\nTail\n"} />);
  // The loading state is plain text; the first rendered paragraph already
  // holds math: the formula commits with its block, never as source first.
  await waitFor(() => expect(view.container.querySelector("p")).not.toBeNull());
  expect(view.container.querySelector("p")?.querySelector(".katex")).not.toBeNull();
  expect(view.container.querySelector("code")).toBeNull();
  view.unmount();
});

test("a repeated formula renders from the cache with no loading state", async () => {
  const first = render(<Formula raw="\\(q\\)" tex="q" display={false} />);
  await waitFor(() => expect(first.container.querySelector(".katex")).not.toBeNull());
  first.unmount();
  const second = render(<Formula raw="\\(q\\)" tex="q" display={false} />);
  expect(second.container.querySelector(".katex")).not.toBeNull();
  expect(second.container.querySelector("code")).toBeNull();
  second.unmount();
});

test("a settled formula keeps its rendered output while later text streams in", async () => {
  const stream = "thread/math-kept";
  const view = render(<Markdown stream={stream} streaming text={"First \\(a\\).\n\nSecond\n"} />);
  await waitFor(() => expect(view.container.querySelectorAll(".katex").length).toBe(1));
  const paragraphs = view.container.querySelectorAll("p");
  expect(paragraphs).toHaveLength(2);
  const settled = paragraphs[0];
  const formula = settled?.querySelector(".katex")?.innerHTML;
  view.rerender(
    <Markdown stream={stream} streaming text={"First \\(a\\).\n\nSecond keeps going\n"} />,
  );
  await screen.findByText(/keeps going/);
  view.rerender(
    <Markdown stream={stream} streaming text={"First \\(a\\).\n\nSecond keeps going\nmore\n"} />,
  );
  await screen.findByText(/more/);
  // The settled block is untouched: the same node with the same rendered math.
  expect(view.container.querySelectorAll("p")[0]).toBe(settled);
  expect(settled?.querySelector(".katex")?.innerHTML).toBe(formula);
  view.unmount();
});
