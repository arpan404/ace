import { botFaceDefaults, isValidFace, type BotFace } from "@ace/ui-core/bot-face";
import { describe, expect, it } from "vitest";
import { choosePart, optionName, partOpen, partOptions, shownName } from "./spade-maker.ts";

const face = (fields: Partial<BotFace>): BotFace => ({ ...botFaceDefaults, ...fields });

describe("the page's face maker", () => {
  it("offers every creature and colour whatever the face wears", () => {
    const fox = face({ body: "fox", pair: "ember" });
    expect(partOptions(fox, "body")).toContain("ghost");
    expect(partOptions(fox, "pair")).toContain("lilac");
  });

  it("has no mouth to pick on a bird, as the app's editor doesn't", () => {
    expect(partOpen(face({ body: "bird", pair: "sky" }), "mouth")).toBe(false);
    expect(partOpen(face({ body: "round" }), "mouth")).toBe(true);
  });

  it("doesn't offer big ears while headphones are on, as the app's editor doesn't", () => {
    const listening = face({ accessory: "headphones" });
    expect(partOptions(listening, "ears")).not.toContain("cat");
    expect(choosePart(listening, "ears", "cat")).toBe(listening);
  });

  it("keeps every face it makes drawable", () => {
    let made = face({});
    made = choosePart(made, "body", "cloud");
    made = choosePart(made, "ears", "bunny");
    made = choosePart(made, "body", "fox");
    expect(isValidFace(made)).toBe(true);
    expect(made.ears).toBe("none");
  });

  it("repairs parts a new creature can't wear", () => {
    const bunny = face({ ears: "bunny" });
    const bot = choosePart(bunny, "body", "bot");
    expect(bot.body).toBe("bot");
    expect(bot.ears).toBe("none");
  });

  it("ignores a value the part doesn't offer", () => {
    const plain = face({});
    expect(choosePart(plain, "ears", "wings")).toBe(plain);
  });

  it("names options as words", () => {
    expect(optionName("headphones")).toBe("Headphones");
  });

  it("shows the typed name, or the same suggested name for the same face", () => {
    const fox = face({ body: "fox", pair: "ember" });
    expect(shownName(fox, "  Atlas ")).toBe("Atlas");
    expect(shownName(fox, "")).toBe(shownName(fox, " "));
    expect(shownName(fox, "")).not.toBe("");
  });
});
