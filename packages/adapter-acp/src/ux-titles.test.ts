import { expect, test } from "vitest";
import { harness } from "./test-helper.ts";
test("ACP and Cursor session info titles are available to the daemon", () => {
  const h = harness();
  h.ready();
  const events = h.update({ sessionUpdate: "session_info_update", title: "Fix login redirect" });
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "item.created",
        item: expect.objectContaining({
          type: "notice",
          code: "thread_title",
          title: "Fix login redirect",
        }),
      }),
    ]),
  );
});

test("adopting an ACP title keeps unknown fields in diagnostics, not the transcript", () => {
  const h = harness();
  h.ready();
  const events = h.update({
    sessionUpdate: "session_info_update",
    title: "A readable title",
    futureMetadata: { providerExtension: "retain this" },
  });
  const notices = events.flatMap((event) =>
    event.type === "item.created" && event.item.type === "notice" ? [event.item] : [],
  );
  expect(notices).toEqual([expect.objectContaining({ code: "thread_title" })]);
  expect(h.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          params: expect.objectContaining({
            update: expect.objectContaining({
              futureMetadata: { providerExtension: "retain this" },
            }),
          }),
        }),
      }),
    ]),
  );
});
