import { describe, expect, it } from "vitest";
import { asksMore, devBotOf, nextDevVersion } from "./dev-plan.ts";

describe("a development bot's version", () => {
  it.each([
    [undefined, "0.0.0-dev.1"],
    ["0.0.0-dev.1", "0.0.0-dev.2"],
    ["0.0.0-dev.41", "0.0.0-dev.42"],
    // A bot linked to a published version starts development over.
    ["1.2.0", "0.0.0-dev.1"],
  ])("after %s is %s", (previous, next) => {
    expect(nextDevVersion(previous)).toBe(next);
  });
});

describe("the development bot of a folder", () => {
  const agents = {
    agents: [
      { id: "a1", name: "Fare watcher", package: { source: "market", name: "fare-watcher" } },
      {
        id: "a2",
        name: "Fare watcher",
        package: { source: "local", name: "fare-watcher", version: "0.0.0-dev.3", hash: "h3" },
      },
      { id: "a3", name: "Other", package: { source: "local", name: "other" } },
      { id: "a4", name: "Plain" },
    ],
  };

  it("is the local one of its name, never the market's", () => {
    expect(devBotOf(agents, "fare-watcher")).toEqual({
      id: "a2",
      name: "Fare watcher",
      version: "0.0.0-dev.3",
      hash: "h3",
    });
  });

  it("is none when no local bot has its name, or the answer has no list", () => {
    expect(devBotOf(agents, "flight-watcher")).toBeUndefined();
    expect(devBotOf({ error: "x" }, "fare-watcher")).toBeUndefined();
  });
});

describe("what a save asks for", () => {
  const before = {
    triggers: [{ kind: "message" }],
    needs: { connectors: [{ id: "example-calendar", why: "Trips." }] },
  };

  it("is nothing for a save that adds nothing", () => {
    expect(asksMore({ plan: { asks_more: [] } }, before, before)).toEqual({
      effects: [],
      more: [],
    });
  });

  it("is each effect Spade's plan says starts off, each new trigger kind and each new app", () => {
    const after = {
      triggers: [{ kind: "message" }, { kind: "webhook", name: "Feed", instruction: "Read it." }],
      needs: {
        connectors: [
          { id: "example-calendar", why: "Trips." },
          { url: "https://mcp.example.com", why: "Fares." },
        ],
      },
    };
    expect(asksMore({ plan: { asks_more: ["publish"] } }, before, after)).toEqual({
      effects: ["publish"],
      more: ["a webhook trigger", "the app https://mcp.example.com"],
    });
  });

  it("with no manifest applied in this run, is only what the plan says", () => {
    expect(asksMore({ plan: { asks_more: ["network"] } }, undefined, before)).toEqual({
      effects: ["network"],
      more: [],
    });
  });
});
