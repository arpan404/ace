import { expect, test } from "vitest";
import { createTranslator } from "./index.ts";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

for (const cascade of [false, true])
  test(`a resumed child's original visible row stops its current run${cascade ? " and descendants" : ""}`, async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: "resumed-child" }], "queue");
      await h.wait(subtype("child-control-ready"));
      const translator = createTranslator({ rootKey: "root" });
      const facts = h.frames.flatMap((frame) => translator.translate(frame, frame.t));
      const child = facts.find(
        (fact) => fact.type === "agent.seen" && fact.native?.nativeId === "worker",
      );
      if (child?.type !== "agent.seen") throw new Error("Missing visible child");
      await h.session.interrupt({ agent: child.agent, cascade });
      const stopped = h.frames
        .filter(
          (frame) =>
            frame.dir === "send" &&
            object(object(frame.data)["request"])["subtype"] === "stop_task",
        )
        .map((frame) => object(object(frame.data)["request"])["task_id"]);
      expect(stopped).toEqual(cascade ? ["worker", "nested-worker"] : ["worker"]);
    } finally {
      await h.session.close("shutdown");
    }
  });

test("a stop racing a completed child succeeds without sending a stale provider stop", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "completed-child" }], "queue");
    await h.wait(subtype("child-control-ready"));
    const translator = createTranslator({ rootKey: "root" });
    const facts = h.frames.flatMap((frame) => translator.translate(frame, frame.t));
    const child = facts.find(
      (fact) => fact.type === "agent.seen" && fact.native?.nativeId === "worker",
    );
    if (child?.type !== "agent.seen") throw new Error("Missing visible child");
    await expect(
      h.session.interrupt({ agent: child.agent, cascade: true }),
    ).resolves.toBeUndefined();
    expect(
      h.frames.some((frame) => object(object(frame.data)["request"])["subtype"] === "stop_task"),
    ).toBe(false);
  } finally {
    await h.session.close("shutdown");
  }
});

test("a completed resumed child's cascade still reaches a descendant registered after completion", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "resumed-late-child" }], "queue");
    await h.wait(subtype("child-control-ready"));
    const translator = createTranslator({ rootKey: "root" });
    const child = h.frames
      .flatMap((frame) => translator.translate(frame, frame.t))
      .find((fact) => fact.type === "agent.seen" && fact.native?.nativeId === "worker");
    if (child?.type !== "agent.seen") throw new Error("Missing visible child");
    await h.session.interrupt({ agent: child.agent, cascade: true });
    const stopped = h.frames
      .filter(
        (frame) =>
          frame.dir === "send" && object(object(frame.data)["request"])["subtype"] === "stop_task",
      )
      .map((frame) => object(object(frame.data)["request"])["task_id"]);
    expect(stopped).toEqual(["nested-worker"]);
  } finally {
    await h.session.close("shutdown");
  }
});
