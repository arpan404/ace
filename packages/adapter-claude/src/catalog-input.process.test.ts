import { expect, test } from "vitest";
import { harness } from "./session.test-helper.ts";
import { object } from "./native.ts";

test("each selected Claude command is dispatched as a /name prompt string carrying the whole message", async () => {
  const identities: { commandId: string; nativeId: string }[] = [];
  const h = await harness(
    undefined,
    "root",
    {},
    { onInputMessage: (identity) => identities.push(identity) },
  );
  try {
    await h.session.send(
      [
        { type: "text", text: "Use " },
        {
          type: "mention",
          entryId: "review",
          kind: "skill",
          name: "review",
          arguments: "focus on auth",
          invocation: { type: "slash", name: "review" },
        },
        { type: "text", text: " then " },
        {
          type: "mention",
          entryId: "deploy",
          kind: "command",
          name: "deploy",
          arguments: "",
          invocation: { type: "slash", name: "quality:deploy" },
        },
      ],
      "queue",
      "with-commands",
    );
    const fakeInputs = () =>
      h.frames.filter(
        (frame) => frame.dir === "recv" && object(frame.data)["subtype"] === "fake_input",
      );
    await expect.poll(() => fakeInputs().length).toBe(2);
    const sent = fakeInputs().map((frame) => object(object(frame.data)["input"]));
    expect(sent.map((input) => object(input["message"])["content"])).toEqual([
      "/review focus on auth\n\nMessage context:\nUse [review] then [deploy]",
      "/quality:deploy\n\nMessage context:\nUse [review] then [deploy]",
    ]);
    // Both admissions echo back as the one message the person sent.
    expect(identities).toEqual(
      sent.map((input) => ({ commandId: "with-commands", nativeId: input["uuid"] })),
    );
  } finally {
    await h.session.close("user");
  }
});

test("a Claude command that cannot be resolved is refused before any input reaches the CLI", async () => {
  const h = await harness();
  try {
    await expect(
      h.session.send(
        [
          { type: "text", text: "Plain" },
          { type: "mention", entryId: "x", kind: "skill", name: "x", arguments: "" },
        ],
        "queue",
      ),
    ).rejects.toThrow("Unresolved command mention");
    expect(
      h.frames.some((frame) => frame.dir === "send" && object(frame.data)["type"] === "user"),
    ).toBe(false);
  } finally {
    await h.session.close("user");
  }
});
