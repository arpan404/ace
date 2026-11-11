import { expect, test } from "vitest";
import {
  mergeSpadeModels,
  parseSpadeAgent,
  parseSpadeAgents,
  parseSpadeEndpoint,
  parseSpadeLiveModels,
  parseSpadeModels,
  spadeRoster,
  spadeHasUsableEndpoint,
  spadeModelFacts,
  splitSpadeModel,
} from "./index.ts";

const agent = (fields: Record<string, unknown>) => ({
  id: "a1",
  name: "Inbox",
  task: "Keep my inbox at zero",
  avatar: { kind: "generated", initials: "IN", color: "teal" },
  model: "openrouter/anthropic/claude",
  conversation: "c1",
  created_at: 1,
  updated_at: 2,
  last_activity: 3,
  state: "idle",
  status: null,
  last_message: { from: "agent", text: "Inbox is clear.", at: 3 },
  ...fields,
});

test("agents keep fields this client doesn't know, and an agent it can't read is left out", () => {
  const agents = parseSpadeAgents(
    JSON.stringify({
      agents: [
        agent({ mood: "cheerful" }),
        { id: "no-conversation", name: "Lost" },
        "not an agent",
        agent({ id: "a2", name: "Trips", state: "working", status: "Reading a page" }),
        agent({
          id: "a3",
          name: "Inbox",
          state: "waiting",
          waiting_for: "approval",
          status: "Waiting for you",
          last_message: {
            from: "person",
            text: "Booked it.",
            at: 4,
            from_agent: { id: "a2", name: "Trips" },
          },
        }),
      ],
    }),
  );
  expect(agents?.map((row) => [row.id, row.name, row.state, row.status])).toEqual([
    ["a1", "Inbox", "idle", undefined],
    ["a2", "Trips", "working", "Reading a page"],
    ["a3", "Inbox", "waiting", "Waiting for you"],
  ]);
  expect(agents?.[2]?.waitingFor).toBe("approval");
  expect(agents?.[2]?.lastMessage?.fromAgent).toEqual({ id: "a2", name: "Trips" });
  expect(agents?.[0]?.lastMessage).toEqual({
    from: "agent",
    text: "Inbox is clear.",
    at: 3,
    fromAgent: undefined,
  });
  expect(agents?.[0]?.raw.mood).toBe("cheerful");
  expect(agents?.[0]?.lastActivity).toBe(3);
  expect(parseSpadeAgents("[]")).toBeUndefined();
});

test("an avatar it can't read becomes a generated one from the agent's name", () => {
  const image = "a".repeat(64);
  const created = parseSpadeAgent(
    JSON.stringify({ agent: agent({ avatar: { kind: "image", sha256: image } }) }),
  );
  expect(created?.avatar).toEqual({ kind: "image", sha256: image });
  const odd = parseSpadeAgent(
    JSON.stringify({ agent: agent({ name: "Ada Lovelace", avatar: { kind: "hologram" } }) }),
  );
  expect(odd?.avatar).toEqual({ kind: "generated", initials: "AL", color: "slate" });
  const offPalette = parseSpadeAgent(
    JSON.stringify({
      agent: agent({ avatar: { kind: "generated", initials: "X", color: "gold" } }),
    }),
  );
  expect(offPalette?.avatar).toEqual({ kind: "generated", initials: "X", color: "slate" });
});

test("Spade is named Spade with its own mark whatever it is sent, and lists first", () => {
  const agents = parseSpadeAgents(
    JSON.stringify({
      agents: [
        agent({ id: "b1", last_activity: 9 }),
        agent({ id: "main", kind: "main", name: "Whatever", last_activity: 1 }),
        agent({ id: "b2", last_activity: 5, kind: "robot" }),
      ],
    }),
  );
  const roster = spadeRoster(agents ?? []);
  expect(roster.map((row) => [row.id, row.kind, row.name])).toEqual([
    ["main", "main", "Spade"],
    ["b1", "bot", "Inbox"],
    ["b2", "bot", "Inbox"],
  ]);
  expect(roster[0]?.avatar).toEqual({ kind: "spade" });
});

test("an agent from a Spade that only says whether it works reads as working or idle", () => {
  const old = parseSpadeAgent(
    JSON.stringify({ agent: agent({ state: undefined, working: true }) }),
  );
  expect(old?.state).toBe("working");
});

test("a model reference splits at its first slash, so model ids keep theirs", () => {
  expect(splitSpadeModel("openrouter/anthropic/claude")).toEqual({
    endpoint: "openrouter",
    model: "anthropic/claude",
  });
});

test("endpoints say whether each needs a key and has one, and odd endpoints are left out", () => {
  const models = parseSpadeModels(
    JSON.stringify({
      endpoints: [
        {
          id: "openrouter",
          name: "OpenRouter",
          format: "openai-chat",
          base_url: "https://openrouter.ai/api/v1",
          header_names: ["x-title"],
          needs_key: true,
          key_set: false,
          key_source: null,
          region: "eu",
          models: [
            { id: "m1", name: "Model one", context: 200000, capabilities: ["images", "tools"] },
            { name: "no id" },
            { id: "m2", capabilities: { reasoning: true, images: false }, source: "typed" },
          ],
        },
        { name: "no id" },
        { id: "local", format: "something-new", base_url: "http://localhost:11434/v1" },
      ],
      presets: [{ id: "opencode-go", name: "OpenCode Go", format: "openai-chat" }, 7],
      fast_model: "local/llama",
    }),
  );
  expect(models?.endpoints.map((endpoint) => [endpoint.id, endpoint.format])).toEqual([
    ["openrouter", "openai-chat"],
    ["local", undefined],
  ]);
  const [openrouter, local] = models?.endpoints ?? [];
  expect(openrouter?.raw.region).toBe("eu");
  expect(openrouter?.headerNames).toEqual(["x-title"]);
  expect(openrouter?.models.map((model) => [model.id, model.name, model.capabilities])).toEqual([
    ["m1", "Model one", ["images", "tools"]],
    ["m2", "m2", ["reasoning"]],
  ]);
  expect(models?.presets.map((preset) => preset.id)).toEqual(["opencode-go"]);
  expect(models?.fastModel).toBe("local/llama");
  expect(spadeHasUsableEndpoint(openrouter ? [openrouter] : [])).toBe(false);
  expect(spadeHasUsableEndpoint(local ? [local] : [])).toBe(true);
});

test("an added endpoint and an endpoint's live list read the same way", () => {
  expect(parseSpadeEndpoint(JSON.stringify({ endpoint: { id: "e1", name: "Mine" } }))?.name).toBe(
    "Mine",
  );
  expect(
    parseSpadeLiveModels(JSON.stringify({ models: [{ id: "x" }, { id: 4 }] }))?.map((m) => m.id),
  ).toEqual(["x"]);
  expect(parseSpadeLiveModels("{}")).toBeUndefined();
});

test("the picker's list keeps typed models and lets the person's edits win over the endpoint's", () => {
  const live = parseSpadeLiveModels(
    JSON.stringify({ models: [{ id: "b", name: "Bee", context: 8000 }, { id: "a" }] }),
  );
  const saved = parseSpadeModels(
    JSON.stringify({
      endpoints: [
        {
          id: "e",
          models: [
            { id: "b", context: 32000, source: "typed" },
            { id: "z-mine", name: "Mine", source: "typed" },
          ],
        },
      ],
    }),
  )?.endpoints[0]?.models;
  const merged = mergeSpadeModels(saved ?? [], live);
  expect(merged.map((model) => [model.id, model.name, model.context])).toEqual([
    ["z-mine", "Mine", undefined],
    ["a", "a", undefined],
    ["b", "Bee", 32000],
  ]);
});

test("a model's facts read as its context and what it can do", () => {
  expect(spadeModelFacts({ context: 200_000, capabilities: ["images", "tools"] })).toBe(
    "200K context · images, tools",
  );
  expect(spadeModelFacts({ context: 1_048_576, capabilities: [] })).toBe("1M context");
  expect(spadeModelFacts({ context: undefined, capabilities: [] })).toBe("");
});
