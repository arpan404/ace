import { describe, expect, it } from "vitest";
import { grantedNeeds, readRecipe, recipeEntries, recipeNeeds } from "./recipe.ts";

const base = {
  format: "spade-bot",
  version: 2,
  name: "Inbox",
  task: "You look after the inbox.",
  model: "fast",
  routines: [{ name: "Morning sort", instruction: "Sort it.", schedule: "weekdays at 8:00" }],
  skills: ["spade-skill/triage-mail", "skills/house-style"],
  plugins: ["spade-plugin/mail-tools"],
  needs: {
    connectors: [
      { id: "gmail", why: "Reads mail.", required: true },
      { url: "https://mcp.example.com/mcp", why: "Files receipts." },
    ],
    tools: ["web_search", "shell"],
  },
};
const read = (value: unknown, folders = ["skills/house-style"]) =>
  readRecipe(JSON.stringify(value), new Set(folders));

describe("bot recipes", () => {
  it("read a version 2 recipe with what it brings and asks for", () => {
    const { recipe, problems } = read(base);
    expect(problems).toEqual([]);
    expect(recipeEntries(recipe!)).toEqual([
      { type: "spade-skill", name: "triage-mail" },
      { type: "spade-plugin", name: "mail-tools" },
    ]);
    expect(recipeNeeds(recipe!).map((need) => [need.key, need.required])).toEqual([
      ["connector:gmail", true],
      ["connector:https://mcp.example.com/mcp", false],
      ["plugin:mail-tools", true],
    ]);
  });

  it("keep fields they don't know as raw data", () => {
    expect(read({ ...base, mood: "cheerful" }).recipe?.extra).toEqual({ mood: "cheerful" });
  });

  it.each([
    ["a field named like a secret", { ...base, webhook_secret: "x" }],
    [
      "a nested token",
      { ...base, needs: { ...base.needs, connectors: [{ id: "gmail", why: "x", token: "abc" }] } },
    ],
    [
      "a key in the task",
      { ...base, task: "Use sk-ant-REDACTEDREDACTEDREDACTEDREDACTED to call it." },
    ],
  ])("are refused whole for %s", (_label, recipe) => {
    const result = read(recipe);
    expect(result.recipe).toBeUndefined();
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it.each([
    ["another source's skill", { ...base, skills: ["git:abc/skill"] }],
    ["an address as a plugin", { ...base, plugins: ["https://evil.example/plugin"] }],
    ["a skill folder it doesn't hold", { ...base, skills: ["skills/missing"] }],
  ])("refuse %s", (_label, recipe) => {
    expect(read(recipe).recipe).toBeUndefined();
  });

  it("never take a model id: model is fast or capable", () => {
    expect(read({ ...base, model: "some-model-v9" }).recipe).toBeUndefined();
  });

  it("read a server need only by its https address", () => {
    const recipe = {
      ...base,
      needs: { connectors: [{ url: "http://plain.example/mcp", why: "x" }] },
    };
    expect(read(recipe).recipe).toBeUndefined();
  });

  it("read a version 1 bot file, its connector choices turned into optional needs", () => {
    const { recipe, notes } = read({
      format: "spade-bot",
      version: 1,
      name: "Old",
      task: "Do it.",
      model: "claude-something",
      routines: [
        {
          name: "Daily",
          instruction: "Go.",
          trigger: { kind: "schedule", schedule: "every day at 9:00" },
        },
        { name: "Hook", instruction: "Go.", trigger: { kind: "webhook" } },
      ],
      connectors: { all: false, connectors: ["gmail"] },
      notes: ["Be brief."],
    });
    expect(recipe).toMatchObject({
      version: 2,
      model: "capable",
      routines: [{ name: "Daily", schedule: "every day at 9:00" }],
      needs: { connectors: [{ id: "gmail", required: false }] },
    });
    expect(notes).toHaveLength(1);
  });

  it("grant only the needs the person left on", () => {
    const needs = recipeNeeds(read(base).recipe!);
    const granted = grantedNeeds(needs, {
      "connector:gmail": false,
      "connector:https://mcp.example.com/mcp": true,
    });
    expect(granted.map((need) => need.key)).toEqual([
      "connector:https://mcp.example.com/mcp",
      "plugin:mail-tools",
    ]);
  });
});
