import { Profiler, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CodeLines } from "./code-lines.ts";
import type { CodeToken } from "./highlight.ts";
import { useCodeLines, useLatestCodeLines } from "./use-code-lines.ts";

// Controllable stand-in for the token source behind runMarkitHighlight: replies arrive when a
// test sends them, like worker postMessages, so queue/cache/stale semantics stay under test
// control. The markit runner itself (worker detection, fallback routing) stays real.
type Input = { code: string; lang: string | undefined; hash: string };
const pending = new Map<string, Array<{ resolve: (value: CodeLines) => void; hash: string }>>();
vi.mock("./code-lines.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-lines.ts")>();
  return {
    ...actual,
    codeLines: vi.fn(
      (input: Input["code"], lang: Input["lang"], hash: string) =>
        new Promise<CodeLines>((resolve) => {
          const list = pending.get(input) ?? [];
          list.push({ resolve, hash });
          pending.set(input, list);
          void lang;
        }),
    ),
  };
});

afterEach(() => {
  pending.clear();
  vi.clearAllMocks();
});

async function reply(code: string, lines: { plain: true } | { lines: CodeToken[][] }) {
  await waitFor(() => expect(pending.get(code)).toHaveLength(1));
  const job = pending.get(code)?.shift();
  if (!job) throw new Error("Missing highlight job");
  await act(async () => job.resolve({ ...lines, hash: job.hash }));
}

test("plain results preserve caller source and reopening never requeues its highlight job", async () => {
  const { codeLines } = await import("./code-lines.ts");
  const source = "\n".repeat(600_000);
  const view = renderHook(() => useCodeLines(source, "typescript"));
  await waitFor(() => expect(vi.mocked(codeLines)).toHaveBeenCalledTimes(1));
  expect(vi.mocked(codeLines).mock.calls[0]?.[0]).toBe(source);
  await reply(source, { plain: true });
  expect(view.result.current).toBeUndefined();
  view.unmount();
  const reopened = renderHook(() => useCodeLines(source, "typescript"));
  await act(async () => {});
  expect(reopened.result.current).toBeUndefined();
  expect(vi.mocked(codeLines)).toHaveBeenCalledTimes(1);
  reopened.unmount();
});

test("a fence scrolled back into view after many others shows its colours with no new job", async () => {
  const { codeLines } = await import("./code-lines.ts");
  const calls = () => vi.mocked(codeLines).mock.calls.length;
  const fences = Array.from({ length: 40 }, (_, index) => `const fence${index} = ${index};`);
  for (const code of fences) {
    const view = renderHook(() => useCodeLines(code, "typescript"));
    await reply(code, { lines: [[{ kind: "keyword", text: "const" }]] });
    expect(view.result.current?.lines[0]?.[0]?.text).toBe("const");
    view.unmount();
  }
  const sent = calls();
  const back = renderHook(() => useCodeLines(fences[0], "typescript"));
  expect(back.result.current?.lines[0]?.[0]?.text).toBe("const");
  await act(async () => {});
  expect(calls()).toBe(sent);
  back.unmount();
});

test("highlight completion commits once, retains colours through cache hits and ignores stale replies", async () => {
  let commits = 0;
  function Wrapper(props: { children: ReactNode }) {
    return (
      <Profiler id="highlight" onRender={() => commits++}>
        {props.children}
      </Profiler>
    );
  }
  const view = renderHook(
    ({ code }) => ({
      current: useCodeLines(code, "typescript"),
      latest: useLatestCodeLines(code, "typescript"),
    }),
    { initialProps: { code: "const retained_a = 1;" }, wrapper: Wrapper },
  );
  const before = commits;
  await reply("const retained_a = 1;", {
    lines: [[{ kind: "keyword", text: "first" }]],
  });
  expect(view.result.current.latest?.lines[0]?.[0]?.text).toBe("first");
  expect(commits - before).toBe(1);
  view.rerender({ code: "const retained_b = 2;" });
  expect(view.result.current.current).toBeUndefined();
  expect(view.result.current.latest?.lines[0]?.[0]?.text).toBe("first");
  await reply("const retained_b = 2;", {
    lines: [[{ kind: "keyword", text: "second" }]],
  });
  view.rerender({ code: "const retained_a = 1;" });
  expect(view.result.current.latest?.lines[0]?.[0]?.text).toBe("first");
  view.rerender({ code: "const retained_stale = 3;" });
  await waitFor(() => expect(pending.get("const retained_stale = 3;")).toHaveLength(1));
  view.rerender({ code: "const retained_new = 4;" });
  // A released job can finish, but cannot overwrite the retained cache hit.
  await reply("const retained_stale = 3;", {
    lines: [[{ kind: "keyword", text: "stale" }]],
  });
  expect(view.result.current.latest?.lines[0]?.[0]?.text).toBe("first");
  await reply("const retained_new = 4;", {
    lines: [[{ kind: "keyword", text: "newest" }]],
  });
  expect(view.result.current.latest?.lines[0]?.[0]?.text).toBe("newest");
});
