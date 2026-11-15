import { describe, expect, test } from "vitest";
import { defaultLabels, labelCaps, suitLabel } from "./suit-labels.ts";

const labels = {
  "composer-placeholder": "Transmit to the grid",
  "working-word": "Jacking in",
  send: "Fire",
  "empty-sidebar": "The street is quiet.",
  "empty-transcript": "Where to, choom?",
} as const;

test.each(Object.entries(defaultLabels))(
  "a Suit's label replaces ace's default %s",
  (key, word) => {
    const label = labels[key as keyof typeof labels];
    expect(suitLabel(labels, key as keyof typeof labels, word)).toBe(label);
  },
);

describe("status words stay ace's whatever the Suit's labels say", () => {
  test.each([
    ["working-word", "Waiting for your approval"],
    ["working-word", "Waiting for 2 subagents"],
    ["working-word", "Failed"],
    ["working-word", "Needs you"],
    ["send", "Queue message"],
    ["send", "Steer message"],
    ["composer-placeholder", "Codex isn't signed in"],
    ["composer-placeholder", "Answer the question above"],
  ] as const)("%s never replaces %j", (key, shown) => {
    expect(suitLabel(labels, key, shown)).toBe(shown);
  });
});

test("without a label, or with one that cleans to nothing, ace's word shows", () => {
  expect(suitLabel(undefined, "send", "Send")).toBe("Send");
  expect(suitLabel({ send: "\u0007\u0000 " }, "send", "Send")).toBe("Send");
});

test("a label is cut to its place's cap and loses control characters", () => {
  const long = suitLabel(
    { "working-word": "Reticulating\u0000 all of the splines" },
    "working-word",
    "Working",
  );
  expect(long).toBe("Reticulating all");
  expect(
    [...suitLabel({ send: "Launch the missiles" }, "send", "Send")].length,
  ).toBeLessThanOrEqual(labelCaps.send);
});
