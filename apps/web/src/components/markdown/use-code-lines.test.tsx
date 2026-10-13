import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

// Hold the worker boundary while the real hook owns its queue/cache lifecycle.
const Request = z.object({
  id: z.number(),
  input: z.object({ code: z.string(), hash: z.string() }),
});
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  requests: z.infer<typeof Request>[] = [];
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(input: unknown) {
    this.requests.push(Request.parse(input));
  }
  terminate() {}
  reply(index: number) {
    const request = this.requests[index];
    if (!request) throw new Error("Missing worker request");
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { id: request.id, output: { hash: request.input.hash, plain: true } },
      }),
    );
  }
}
afterEach(() => vi.unstubAllGlobals());

test("plain results preserve caller source and reopening never requeues its highlight job", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const { useCodeLines } = await import("./use-code-lines.ts");
  const source = "\n".repeat(600_000);
  const view = renderHook(() => useCodeLines(source, "typescript"));
  await waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error("Missing highlight worker");
  const request = worker.requests[0];
  if (!request) throw new Error("Missing worker request");
  expect(request.input.code).toBe(source);
  await act(async () => worker.reply(0));
  expect(view.result.current).toBeUndefined();
  view.unmount();
  const reopened = renderHook(() => useCodeLines(source, "typescript"));
  await act(async () => {});
  expect(reopened.result.current).toBeUndefined();
  expect(worker.requests).toHaveLength(1);
  reopened.unmount();

  // The legacy markdown bridge still accepts whole-source jobs and shares the result union.
  const { markdownWorker } = await import("./worker.ts");
  const result = markdownWorker.run({ code: source, hash: request.input.hash });
  const legacy = FakeWorker.instances[1];
  if (!legacy) throw new Error("Missing legacy worker");
  legacy.reply(0);
  await expect(result).resolves.toEqual({ hash: request.input.hash, plain: true });
});

test("a fence scrolled back into view after many others shows its colours with no new job", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const { useCodeLines } = await import("./use-code-lines.ts");
  const fences = Array.from({ length: 40 }, (_, index) => `const fence${index} = ${index};`);
  const worker = () => FakeWorker.instances[0];
  const before = worker()?.requests.length ?? 0;
  for (const [index, code] of fences.entries()) {
    const view = renderHook(() => useCodeLines(code, "typescript"));
    await waitFor(() => expect(worker()?.requests.length).toBe(before + index + 1));
    const request = worker()?.requests.at(-1);
    if (!request) throw new Error("Missing worker request");
    await act(async () =>
      worker()?.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: request.id,
            output: { hash: request.input.hash, lines: [[{ kind: "keyword", text: "const" }]] },
          },
        }),
      ),
    );
    expect(view.result.current?.lines[0]?.[0]?.text).toBe("const");
    view.unmount();
  }
  const sent = worker()?.requests.length;
  const back = renderHook(() => useCodeLines(fences[0], "typescript"));
  expect(back.result.current?.lines[0]?.[0]?.text).toBe("const");
  await act(async () => {});
  expect(worker()?.requests.length).toBe(sent);
  back.unmount();
});
