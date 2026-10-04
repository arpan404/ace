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
