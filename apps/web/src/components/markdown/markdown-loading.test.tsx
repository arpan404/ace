import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Markdown } from "./markdown.tsx";
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

const text = "**Server:** Ready.\n\n```sh\necho ready\n```";

test("opening a message shows loading until the worker replies, without flashing markdown", async () => {
  vi.useFakeTimers();
  const view = render(<Markdown text={text} stream="open-message" />);
  expect(screen.getByRole("status", { name: "Loading message" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("**Server:**");
  expect(view.container.textContent).not.toContain("```");
  await act(() => vi.advanceTimersByTimeAsync(1499));
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.queryByText("Server:")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("Server:")).toBeTruthy();
  expect(view.container.textContent).toContain("echo ready");
  expect(view.container.textContent).not.toContain("```");

  view.unmount();
  render(<Markdown text={text} stream="open-message" />);
  expect(screen.getByText("Server:")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

test("an existing render stays visible while the worker prepares newer text", async () => {
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
