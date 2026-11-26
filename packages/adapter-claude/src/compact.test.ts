import { expect, test } from "vitest";
import { object } from "./native.ts";
import { harness, subtype } from "./session.test-helper.ts";

test("compaction dispatches /compact as ace's own synthetic input, never the person's message", async () => {
  const h = await harness();
  try {
    await h.session.compact?.();
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(object(input["message"])["content"]).toBe("/compact");
    expect(input["isSynthetic"]).toBe(true);
  } finally {
    await h.session.close("user");
  }
});
