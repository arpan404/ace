import { describe, expect, it } from "vitest";
import { asksMore, devBotOf, devFolderKey } from "./dev-plan.ts";

/** A contract named `name`, with nothing else to compare. */
const contract = (name: string) => ({ name, summary: "A fare.", input: {}, output: {} });

describe("the development bot of a folder", () => {
  const key = devFolderKey("/work/fare-watcher");
  const agents = {
    agents: [
      {
        id: "a1",
        name: "Fare watcher",
        from_recipe: { source: "market", name: key, version: "dev" },
      },
      {
        id: "a2",
        name: "Flight watcher",
        from_recipe: { source: "local", name: key, version: "dev" },
      },
      {
        id: "a3",
        name: "Fare watcher",
        from_recipe: { source: "local", name: devFolderKey("/other/fare-watcher"), version: "dev" },
      },
      { id: "a4", name: "Plain" },
    ],
  };

  it("is the one made from that folder, whatever its name is now", () => {
    expect(devBotOf(agents, key)).toEqual({ id: "a2", name: "Flight watcher" });
  });

  it("is another bot for a folder of the same name somewhere else", () => {
    expect(devBotOf(agents, devFolderKey("/other/fare-watcher"))?.id).toBe("a3");
  });

  it("is none for a folder no bot was made from, or an answer with no list", () => {
    expect(devBotOf(agents, devFolderKey("/work/hotel-watcher"))).toBeUndefined();
    expect(devBotOf({ error: "x" }, key)).toBeUndefined();
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

  it("is each new contract, since other bots may now call it", () => {
    const offering = { ...before, contracts: [contract("cheapest_fare")] };
    const more = { ...before, contracts: [contract("cheapest_fare"), contract("fare_history")] };
    expect(asksMore({ plan: { asks_more: [] } }, offering, more).more).toEqual([
      "the contract fare_history, which your other bots may call",
    ]);
    expect(asksMore({ plan: { asks_more: [] } }, more, offering).more).toEqual([]);
  });

  it("with no manifest applied in this run, is only what the plan says", () => {
    expect(asksMore({ plan: { asks_more: ["network"] } }, undefined, before)).toEqual({
      effects: ["network"],
      more: [],
    });
  });
});
