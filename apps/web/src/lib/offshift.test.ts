import { expect, test, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { OffshiftRefused, requestOffshift } from "./offshift.ts";

test("a change resolves with the run view the daemon returns", async () => {
  const view = { run: { id: "login" } };
  const request = vi.fn().mockResolvedValue({ ok: true, view });
  await expect(
    requestOffshift(
      { request: request } as never,
      ThreadId.parse("thread-1"),
      { action: "end", runId: "login", expectedVersion: 5, note: "Done" },
      { requestId: "r1" },
    ),
  ).resolves.toBe(view);
  expect(request).toHaveBeenCalledWith(
    {
      type: "offshift.request",
      requestId: "r1",
      threadId: "thread-1",
      op: { action: "end", runId: "login", expectedVersion: 5, note: "Done" },
    },
    {},
  );
});

test("a refusal throws with its code, message and standing view", async () => {
  const view = { run: { id: "login" } };
  const request = vi
    .fn()
    .mockResolvedValue({ ok: false, error: "conflict", message: "Changed", view });
  const error = await requestOffshift(
    { request } as never,
    ThreadId.parse("thread-1"),
    { action: "step", runId: "login", expectedVersion: 4, stepId: "repro", state: "done" },
    { requestId: "r2" },
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(OffshiftRefused);
  expect(error).toMatchObject({ code: "conflict", message: "Changed", view });
});
