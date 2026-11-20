import { expect, test } from "vitest";
import { faceForId, storedBotFace } from "../bot-face/index.ts";
import {
  parseSpadeAgentValue,
  spadeAccentChoicesOn,
  spadeAgentAccent,
  spadeBotMarkAccent,
  spadeStandardCanvases,
  type SpadeAvatar,
} from "./index.ts";

const face: SpadeAvatar = {
  kind: "character",
  face: faceForId("trips"),
  raw: storedBotFace(faceForId("trips")),
};

test("a bot's own accent is used where it holds on the live surfaces, else its face's colour", () => {
  expect(spadeAgentAccent(face, "light", { accent: "#2f7bea" }, ["#ffffff", "#f4f4f2"])).toBe(
    "#2f7bea",
  );
  // A Suit whose panel is a mid blue: the blue no longer holds there.
  const fallback = spadeAgentAccent(face, "light", { accent: "#2f7bea" }, ["#ffffff", "#4a7fd0"]);
  expect(fallback).not.toBe("#2f7bea");
  expect(fallback).toBe(spadeAgentAccent(face, "light"));
});

test("only a bot with a style marks its face and row; Spade and pictures never do", () => {
  expect(spadeBotMarkAccent(face, "dark", undefined)).toBeUndefined();
  expect(spadeBotMarkAccent(face, "dark", { accent: undefined })).toBeUndefined();
  expect(spadeBotMarkAccent(face, "dark", { accent: "#8b5cf6" })).toBe("#8b5cf6");
  expect(spadeBotMarkAccent({ kind: "spade" }, "dark", { accent: "#ffff00" }, ["#ffffff"])).toBe(
    undefined,
  );
});

test("the profile offers only colours that hold on every surface of both schemes", () => {
  expect(spadeAccentChoicesOn(spadeStandardCanvases).length).toBe(6);
  // A Suit with a mid-grey dark canvas: only the lighter choices hold on it and on white.
  const offered = spadeAccentChoicesOn({ light: ["#ffffff"], dark: ["#3a3a3a"] });
  expect(offered.length).toBeLessThan(6);
  for (const choice of offered)
    expect(spadeAgentAccent(face, "dark", { accent: choice.hex }, ["#3a3a3a"])).toBe(choice.hex);
  expect(spadeAccentChoicesOn({ light: ["#808080"], dark: ["#808080"] })).toEqual([]);
});

const agentWith = (style: unknown, kind = "bot") =>
  parseSpadeAgentValue({ id: "a", kind, conversation: "c", name: "A", style });

test("a bot's style reads from Spade leniently, and Spade itself has none", () => {
  expect(agentWith({ accent: "#2F7BEA", chosen: false })?.style).toEqual({
    accent: "#2f7bea",
    chosen: false,
  });
  expect(agentWith({ accent: null, chosen: true })?.style).toEqual({
    accent: undefined,
    chosen: true,
  });
  expect(agentWith({ accent: "red; x" })?.style).toBeUndefined();
  expect(agentWith(null)?.style).toBeUndefined();
  expect(agentWith({ accent: "#2f7bea", chosen: true }, "main")?.style).toBeUndefined();
});
