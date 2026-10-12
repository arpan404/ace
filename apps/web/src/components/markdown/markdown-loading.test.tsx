import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MarkdownJob } from "./worker.ts";

// The worker boundary answers after 1.5 s on a controlled clock. The real parser still
// produces the document; no sleeps or elapsed-time assertions gate this regression.
vi.mock("./worker.ts", async () => {
  const { StreamRegistry } = await import("./stream-registry.ts");
  const streams = new StreamRegistry(() => performance.now());
  const apply = (job: MarkdownJob) => {
    if ("code" in job) throw new Error("Unexpected code job");
    return "release" in job ? streams.release(job.release) : streams.apply(job);
  };
  return {
    localStreams: streams,
    markdownWorker: {
      parallel: true,
      run: (job: MarkdownJob) =>
        new Promise((resolve) => setTimeout(() => resolve(apply(job)), 1500)),
    },
  };
});

afterEach(() => vi.useRealTimers());

/** A fresh renderer and markdown store per test, so none depends on what ran before it. */
async function freshMarkdown() {
  vi.resetModules();
  return (await import("./markdown.tsx")).Markdown;
}

const text = "**Server:** Ready.\n\n```sh\necho ready\n```";

test("opening a thread shows its finished messages at once while the worker starts", async () => {
  const Markdown = await freshMarkdown();
  vi.useFakeTimers();
  const view = render(<Markdown text={text} stream="open-message" />);
  // Built in place on the first render: no skeleton, and never the markdown source.
  expect(screen.queryByRole("status", { name: "Loading message" })).toBeNull();
  expect(screen.getByText("Server:")).toBeTruthy();
  expect(view.container.textContent).toContain("echo ready");
  expect(view.container.textContent).not.toContain("**Server:**");
  expect(view.container.textContent).not.toContain("```");
  view.unmount();
  render(<Markdown text={text} stream="open-message" />);
  expect(screen.getByText("Server:")).toBeTruthy();
});

test("a message built in place while the worker starts injects no markup", async () => {
  const Markdown = await freshMarkdown();
  const { container } = render(
    <Markdown
      text={
        '<img src=x onerror="alert(1)">\n\n[run](javascript:alert(1))\n\n<script>alert(2)</script>'
      }
      stream="unsafe-message"
    />,
  );
  expect(container.querySelector("img, script")).toBeNull();
  expect(screen.queryByRole("link", { name: "run" })).toBeNull();
  expect(container.textContent).toContain("<script>alert(2)</script>");
});

test("once the worker is running, a new message shows loading until it replies, without flashing markdown", async () => {
  const Markdown = await freshMarkdown();
  vi.useFakeTimers();
  // A streaming message always goes to the worker; once it has answered, the worker is warm.
  render(<Markdown text="Warm-up." stream="warm-up" streaming />);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  const view = render(<Markdown text={text} stream="later-message" />);
  expect(screen.getByRole("status", { name: "Loading message" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("**Server:**");
  expect(view.container.textContent).not.toContain("```");
  await act(() => vi.advanceTimersByTimeAsync(1499));
  expect(screen.getByRole("status", { name: "Loading message" })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("status", { name: "Loading message" })).toBeNull();
  expect(view.container.textContent).toContain("Server:");
  expect(view.container.textContent).toContain("echo ready");
  expect(view.container.textContent).not.toContain("```");

  view.unmount();
  render(<Markdown text={text} stream="later-message" />);
  expect(screen.getAllByText("Server:").length).toBeGreaterThan(0);
  expect(screen.queryByRole("status", { name: "Loading message" })).toBeNull();
});

test("an existing render stays visible while the worker prepares newer text", async () => {
  const Markdown = await freshMarkdown();
  vi.useFakeTimers();
  const view = render(<Markdown text="**First answer**" stream="growing-message" streaming />);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByText("First answer")).toBeTruthy();
  view.rerender(<Markdown text="**Second answer**" stream="growing-message" />);
  expect(screen.getByText("First answer")).toBeTruthy();
  expect(view.container.textContent).not.toContain("**Second answer**");
  await act(() => vi.advanceTimersByTimeAsync(1499));
  expect(screen.getByText("First answer")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByText("Second answer")).toBeTruthy();
  expect(screen.queryByText("First answer")).toBeNull();
});
