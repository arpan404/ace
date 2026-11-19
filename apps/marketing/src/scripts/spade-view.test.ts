import { describe, expect, it } from "vitest";
import { panelOpenAt, phoneViewAt } from "./spade-view.ts";

describe("the walkthrough's messenger at each step", () => {
  it("opens the profile for the bot, its computer, memory, routines, apps and model", () => {
    const open = Array.from({ length: 12 }, (_, step) => step).filter(panelOpenAt);
    expect(open).toEqual([0, 3, 4, 5, 6, 9]);
  });

  it("shows a phone the list where its rows tell the feature", () => {
    expect([1, 5, 11].map(phoneViewAt)).toEqual(["list", "list", "list"]);
  });

  it("shows a phone the profile sheet for the bot's details, computer, memory and model", () => {
    expect([0, 3, 4, 9].map(phoneViewAt)).toEqual(["panel", "panel", "panel", "panel"]);
  });

  it("shows a phone the conversation for the rest, even where the profile is open beside it", () => {
    expect([2, 6, 7, 8, 10].map(phoneViewAt)).toEqual(["chat", "chat", "chat", "chat", "chat"]);
  });
});
