import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test("a Codex root name becomes a title notice for the daemon's shared title owner", () => {
  const h = setup();
  h.recv("thread/name/updated", {
    threadId: "native",
    threadName: "Readable provider title",
    futureField: true,
  });
  expect(Object.values(h.state.items)).toContainEqual(
    expect.objectContaining({
      type: "notice",
      code: "thread_title",
      title: "Readable provider title",
      raw: [
        {
          type: "thread/name/updated",
          data: {
            method: "thread/name/updated",
            params: {
              threadId: "native",
              threadName: "Readable provider title",
              futureField: true,
            },
          },
        },
      ],
    }),
  );
});
test("names broadcast for unrelated or child threads do not rename the root or create work", () => {
  const h = setup();
  h.start();
  h.end();
  h.recv("thread/name/updated", { threadId: "unrelated", threadName: "Other" });
  h.recv("thread/name/updated", { threadId: "native", threadName: null });
  h.recv("thread/name/updated", { threadId: "native", threadName: "  " });
  expect(Object.values(h.state.items)).toHaveLength(0);
  expect(h.state.status.state).toBe("done");
  h.recv("thread/started", { thread: { id: "child", parentThreadId: "native" } });
  h.recv("thread/name/updated", { threadId: "child", threadName: "Child" });
  expect(
    Object.values(h.state.items).some(
      (item) => item.type === "notice" && item.code === "thread_title",
    ),
  ).toBe(false);
});
test("a resumed Codex thread carries its saved provider name", () => {
  const h = setup();
  h.send("thread/resume", { threadId: "native" });
  h.feed({
    seq: 99,
    t: 99,
    dir: "recv",
    channel: "stdio",
    data: { id: 90, result: { thread: { id: "native", name: "Saved title", turns: [] } } },
  });
  expect(Object.values(h.state.items)).toContainEqual(
    expect.objectContaining({ type: "notice", code: "thread_title", title: "Saved title" }),
  );
});
