import { describe, expect, it } from "vitest";
import { asksMore, devBotOf, localPackageName } from "./dev-plan.ts";

describe("the local package a development bot is linked to", () => {
  it.each([
    ["Fare watcher", "local/fare-watcher"],
    ["  Fare -- Watcher 2 ", "local/fare-watcher-2"],
    // Spade keeps ASCII letters and digits only.
    ["Café bot", "local/caf-bot"],
    ["!!!", "local/bot"],
  ])("for %s is %s", (name, package_) => {
    expect(localPackageName(name)).toBe(package_);
  });
});

describe("the development bot of a folder", () => {
  const agents = {
    agents: [
      { id: "a1", name: "Fare watcher", package: { source: "market", name: "local/fare-watcher" } },
      {
        id: "a2",
        name: "Fare watcher",
        package: { source: "local", name: "local/fare-watcher", version: "local", hash: "h2" },
      },
      { id: "a3", name: "Other", package: { source: "local", name: "local/other" } },
      { id: "a4", name: "Plain" },
    ],
  };

  it("is the local one of its name, never the market's", () => {
    expect(devBotOf(agents, "local/fare-watcher")).toEqual({ id: "a2", name: "Fare watcher" });
  });

  it("is none when no local bot has its name, or the answer has no list", () => {
    expect(devBotOf(agents, "local/flight-watcher")).toBeUndefined();
    expect(devBotOf({ error: "x" }, "local/fare-watcher")).toBeUndefined();
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
