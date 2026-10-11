import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("a steer rejected because its turn ended delivers the same input in a new turn", async () => {
  const h = await sessionHarness(false, "steer-race");
  try {
    await h.session.send([{ type: "text", text: "steer-race" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/started");
    await h.session.send([{ type: "text", text: "finish" }], "steer", "next-input");
    await h.wait(
      (frame) =>
        Boolean(obj(obj(frame.data)["params"])["turn"]) &&
        obj(frame.data)["method"] === "turn/completed",
    );
    const inputs = h.frames
      .filter((frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/start")
      .map((frame) => obj(obj(frame.data)["params"])["input"]);
    expect(inputs).toContainEqual([{ type: "text", text: "finish", text_elements: [] }]);
  } finally {
    await h.dispose();
  }
});
