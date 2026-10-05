import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("an answered async question sends option labels and its echo carries interaction_answer", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "question" }], "steer");
    await h.wait((f) => obj(obj(obj(f.data)["params"])["item"])["id"] === "q");
    const interaction = h.replay.state.interactions["async:q"];
    await h.session.resolve("async:q", { kind: "question", answers: { q0: ["tabs"] } });
    await h.wait((f) => obj(obj(obj(f.data)["params"])["item"])["id"] === "answer-echo");
    expect(h.replay.state.items["answer-echo"]).toMatchObject({
      parts: [{ type: "text", text: "Tabs" }],
      synthetic: true,
      origin: { kind: "interaction_answer", interactionId: interaction?.id },
    });
    expect(h.replay.state.interactions["async:q"]?.state).toBe("resolved");
  } finally {
    await h.dispose();
  }
});
test("a plan decision echo belongs to the plan interaction", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "plan" }], "steer");
    await h.wait((f) => obj(f.data)["method"] === "turn/completed");
    const interaction = h.replay.state.interactions["plan:turn"];
    expect(interaction).toBeDefined();
    await h.session.resolve("plan:turn", { kind: "plan_review", decision: "approve" });
    await h.wait((f) => obj(obj(obj(f.data)["params"])["item"])["id"] === "plan-answer-echo");
    expect(h.replay.state.items["plan-answer-echo"]).toMatchObject({
      synthetic: true,
      origin: { kind: "interaction_answer", interactionId: interaction?.id },
    });
  } finally {
    await h.dispose();
  }
});
