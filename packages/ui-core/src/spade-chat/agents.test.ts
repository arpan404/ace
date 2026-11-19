import { faceForId } from "../bot-face/index.ts";
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
  spadeFirstUsableModel,
  spadeModelFacts,
  spadeModelState,
  spadePresetChoices,
  spadeServerName,
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

const readAvatar = (avatar: unknown, id = "b9") =>
  parseSpadeAgent(JSON.stringify({ agent: agent({ id, avatar }) }))?.avatar;

test("a character face reads repaired; initials or an unreadable avatar become the face the id seeds", () => {
  const image = "a".repeat(64);
  expect(readAvatar({ kind: "image", sha256: image })).toEqual({ kind: "image", sha256: image });
  const fox = readAvatar({
    kind: "character",
    v: 1,
    body: "fox",
    pair: "ember",
    ears: "cat",
    glow: 1,
  });
  expect(fox?.kind === "character" && fox.face).toMatchObject({
    body: "fox",
    pair: "ember",
    ears: "none",
  });
  expect(fox?.kind === "character" && fox.raw.glow).toBe(1);
  for (const old of [
    { kind: "generated", initials: "X", color: "gold" },
    { kind: "hologram" },
    undefined,
  ]) {
    const shown = readAvatar(old, "bot-1");
    expect(shown?.kind === "character" && shown.face).toEqual(faceForId("bot-1"));
  }
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

const read = (fields: Record<string, unknown>) =>
  parseSpadeAgent(JSON.stringify({ agent: agent(fields) }));

test("an agent says where its seen cursor is and whether it finished unseen, and an older Spade reads as seen", () => {
  const sent = read({
    seen_seq: 7,
    unseen: true,
    last_message: { from: "agent", text: "Done.", at: 1, seq: 9, from_agent: null },
  });
  expect([sent?.seenSeq, sent?.unseen, sent?.lastMessage?.seq]).toEqual([7, true, 9]);
  const older = read({ last_message: { from: "agent", text: "Hi", at: 1, from_agent: null } });
  expect([older?.seenSeq, older?.unseen, older?.lastMessage?.seq]).toEqual([
    undefined,
    false,
    undefined,
  ]);
  // Odd values don't lose the agent.
  expect(read({ seen_seq: "x", unseen: "yes" })?.unseen).toBe(false);
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

const setUp = (body: unknown) => parseSpadeModels(JSON.stringify(body))?.endpoints ?? [];

test("a bot's model can answer only on an endpoint the person can use now", () => {
  const endpoints = setUp({
    endpoints: [
      { id: "keyed", needs_key: true, key_set: true, models: [{ id: "m" }] },
      { id: "keyless", needs_key: true, key_set: false, models: [{ id: "m" }] },
      { id: "asking", needs_key: true, key_set: null, models: [] },
      { id: "local", needs_key: false, models: [] },
    ],
  });
  expect(spadeModelState("", endpoints)).toBe("none");
  expect(spadeModelState("gone/m", endpoints)).toBe("none");
  expect(spadeModelState("keyless/m", endpoints)).toBe("none");
  expect(spadeModelState("asking/m", endpoints)).toBe("checking");
  expect(spadeModelState("keyed/m", endpoints)).toBe("ready");
  expect(spadeModelState("local/llama", endpoints)).toBe("ready");
  expect(spadeModelState("cli:codex/gpt", endpoints)).toBe("ready");
});

test("the first usable model is named from the person's endpoints, and is none without one", () => {
  const endpoints = setUp({
    endpoints: [
      { id: "keyless", needs_key: true, key_set: false, models: [{ id: "a" }] },
      { id: "empty", needs_key: false, models: [] },
      { id: "local", needs_key: false, models: [{ id: "llama" }, { id: "qwen" }] },
    ],
  });
  expect(spadeFirstUsableModel(endpoints)).toBe("local/llama");
  expect(spadeFirstUsableModel(endpoints.slice(0, 2))).toBeUndefined();
});

test("first-run offers each service once, by its plain name", () => {
  const presets = parseSpadeModels(
    JSON.stringify({
      presets: [
        { id: "go", name: "OpenCode Go" },
        { id: "go-anthropic", name: "OpenCode Go (Anthropic format)" },
        { id: "google", name: "Google Gemini (OpenAI format)" },
        { id: "zai", name: "Z.AI" },
      ],
    }),
  )?.presets;
  expect(
    spadePresetChoices(presets ?? []).map((choice) => [choice.preset.id, choice.label]),
  ).toEqual([
    ["go", "OpenCode Go"],
    ["google", "Google Gemini"],
    ["zai", "Z.AI"],
  ]);
});

test("a server added by its address is named for where it runs", () => {
  expect(spadeServerName("http://localhost:11434/v1/")).toBe("Local server");
  expect(spadeServerName(" http://127.0.0.1:1234/v1 ")).toBe("Local server");
  expect(spadeServerName("http://[::1]:8080/")).toBe("Local server");
  expect(spadeServerName("https://models.example.com/v1/")).toBe("models.example.com");
  expect(spadeServerName("localhost:11434")).toBeUndefined();
  expect(spadeServerName("ftp://example.com/")).toBeUndefined();
});
