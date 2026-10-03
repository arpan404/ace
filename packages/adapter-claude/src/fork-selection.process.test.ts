import { expect, test } from "vitest";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

test("Claude forks at the exact native message with a distinct session identity", async () => {
  const source = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9";
  const message = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9daa";
  const h = await harness(
    undefined,
    "root",
    {},
    {
      fork: { nativeSessionId: source, point: { type: "item", nativeId: message } },
    },
  );
  try {
    const control = await h.wait(subtype("fake_control"));
    expect(object(control.data)["argv"]).toEqual(
      expect.arrayContaining([
        `--resume=${source}`,
        "--fork-session",
        `--resume-session-at=${message}`,
      ]),
    );
    expect(h.session.nativeSessionId).not.toBe(source);
    await h.session.send([{ type: "text", text: "continue branch" }], "queue");
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(input["session_id"]).toBe(h.session.nativeSessionId);
  } finally {
    await h.session.close("shutdown");
  }
});

test("Claude changes model and effort without replacing its native session", async () => {
  const h = await harness();
  try {
    const nativeId = h.session.nativeSessionId;
    if (!h.session.configure) throw new Error("Live configuration is required");
    await h.session.configure({
      provider: "claude",
      model: "next-model",
      options: { effort: "high" },
    });
    const model = await h.wait(
      (f) =>
        subtype("fake_control")(f) && object(object(f.data)["request"])["subtype"] === "set_model",
    );
    expect(object(object(model.data)["request"])["model"]).toBe("next-model");
    const flags = await h.wait(
      (f) =>
        subtype("fake_control")(f) &&
        object(object(f.data)["request"])["subtype"] === "apply_flag_settings",
    );
    expect(object(object(flags.data)["request"])["settings"]).toMatchObject({
      effortLevel: "high",
    });
    await h.session.send([{ type: "text", text: "continue native history" }], "queue");
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(input["session_id"]).toBe(nativeId);
  } finally {
    await h.session.close("shutdown");
  }
});
