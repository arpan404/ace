import { FakeSpadeApi, type FakeDaemon } from "@ace/fake-daemon";

/*
 * Spade on the fixture's machine (ADR 0121, 0139): turned on in Settings › Beta and running,
 * with Spade itself, a bot waiting on an approval, one on a card of questions (with another left
 * for later), one working, one that finished (with a profile filled in: its task, a routine,
 * notes, a page, a file, a skill and its computer), and a group Spade leads (ADR 0132). For New
 * bot and Settings › Spade: two endpoints (one with its key in the keychain, one without), a
 * preset to add, a template and two connected apps. `POST
 * /review/spade` stages the rest: `off` turns Beta's switch off (the tab goes), `on` back on,
 * `stream` has the finished bot start a reply and stream its first words, `hold` has Spade take a
 * card's answer but send the update only on `release`. `on` also puts back
 * what earlier tests changed (answers, keys, bots made), so each starts from the seed whatever
 * ran before it.
 */

export type SpadeScenario = "off" | "on" | "stream" | "hold" | "release";

let api: FakeSpadeApi | undefined;
let asks = 0;
/** Builder's open reply: the one asking, then answered and still open. */
let asking = "r-builder-0";
const tests = { command: "bun run test:fast apps/ios/bridge" };
/** Lets held card settlements through (`hold`). */
let release: (() => void) | undefined;
/** Planner's waiting card, asked again once answered. */
let planning = 0;
const trip = [
  {
    prompt: "Where to?",
    kind: "choice",
    options: ["Lisbon", { label: "Porto", detail: "By train from Lisbon" }],
  },
  { prompt: "How many nights?", kind: "number", min: 1, max: 14, unit: "nights" },
];

export function seedSpade(daemon: FakeDaemon, now: number): void {
  daemon.services.settings.seed({ "beta.spade": true, "spade.enabled": true });
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  const spade = new FakeSpadeApi(daemon.spade, Date.now);
  api = spade;
  const minute = 60_000;
  const main = spade.addAgent({ id: "spade", name: "Spade", kind: "main", last_activity: now });
  spade.store(main.conversation, { type: "user_message", text: "What's on today?" });
  spade.reply(main, "Two reviews are waiting, and the release notes need a last read.");
  const builder = spade.addAgent({ id: "builder", name: "Builder", last_activity: now - minute });
  spade.store(builder.conversation, {
    type: "user_message",
    text: "Run the tests for the iOS bridge",
  });
  spade.ask(builder, "call-tests", "shell", tests, asking);
  const planner = spade.addAgent({
    id: "planner",
    name: "Planner",
    last_activity: now - 45 * minute,
  });
  spade.store(planner.conversation, { type: "user_message", text: "Plan a weekend away" });
  spade.card(planner, "q-tone", [{ prompt: "Any places you'd rather skip?" }], true);
  spade.card(planner, "q-trip-0", trip);
  spade.addAgent({
    id: "research",
    name: "Research",
    state: "working",
    status: "Reading the Swift concurrency notes",
    last_activity: now - 2 * minute,
  });
  const notes = spade.addAgent({
    id: "notes",
    name: "Notes",
    task: "Summarise what merged each day, in three lines or fewer.",
    model: "anthropic/claude-sonnet-4-5",
    last_activity: now - 30 * minute,
  });
  spade.store(notes.conversation, { type: "user_message", text: "Summarise yesterday's PRs" });
  spade.reply(notes, "Three merged: the Work card fix, the market Worker and the Beta page.");
  seedProfile(spade);
  seedGroup(spade, now - 50 * minute);
  seedSetup(spade);
}

/** The seed's bots: any other was made by a test, and goes when the next one starts. */
const seeded = new Set(["spade", "builder", "planner", "research", "notes"]);

/** Endpoints, a preset, a template and apps, for New bot and Settings › Spade. */
function seedSetup(spade: FakeSpadeApi): void {
  spade.endpoints = [
    {
      id: "anthropic",
      name: "Anthropic",
      format: "anthropic",
      base_url: "https://api.anthropic.com",
      needs_key: true,
      key_set: true,
      key_source: "keychain",
      models: [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      format: "openai-chat",
      base_url: "https://openrouter.ai/api/v1",
      needs_key: true,
      key_set: false,
      key_source: null,
      models: [{ id: "moonshotai/kimi-k2", name: "Kimi K2" }],
    },
  ];
  spade.presets = [
    {
      id: "moonshot",
      name: "Moonshot (OpenAI format)",
      format: "openai-chat",
      base_url: "https://api.moonshot.ai/v1",
      models: [{ id: "kimi-k2", name: "Kimi K2" }],
    },
  ];
  spade.fastModel = "anthropic/claude-haiku-4-5";
  spade.teams.templates = [
    {
      id: "reviewer",
      name: "Reviewer",
      blurb: "Reads pull requests and says what needs another look",
      task: "Review pull requests",
      routines: [{ name: "Morning reviews", words: "Weekdays at 9:00" }],
    },
  ];
  spade.connectors.connectors = [
    {
      id: "github",
      name: "GitHub",
      url: "https://api.github.com/mcp",
      state: "connected",
      account: "ace-dev",
      tools: 12,
    },
    {
      id: "linear",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      state: "needs_reconnect",
      tools: 0,
    },
  ];
  spade.connectors.access.set("notes", { all: false, connectors: ["github"] });
}

/** What Notes keeps and has used, for its profile; and what Spade knows about the person. */
function seedProfile(spade: FakeSpadeApi): void {
  spade.routines.agentRoute("POST", "notes", "routines", {
    name: "Morning summary",
    instruction: "Summarise yesterday's merges",
    trigger: { kind: "schedule", schedule: "weekdays at 9:00" },
  });
  spade.notes.add({ text: "Keep summaries to three lines.", agent: "notes" });
  spade.notes.add({ text: "Works on the ace iPhone app." });
  spade.knowledge.add({ agent: "notes", title: "How releases are named", body: "By date." });
  spade.files.set("notes", { "summaries/monday.md": "# Monday", "style.md": "Short." });
  spade.skillStore = {
    ace: false,
    skills: [{ id: "sk-digest", name: "Daily digest", origin: "spade", written_by: ["notes"] }],
  };
  spade.computer.use("notes", { kind: "terminal", live: false, title: "gh pr list", last: 1 });
  spade.services.start("notes", { name: "Digest preview", command: "bun run preview" });
}

/** Launch team: Spade leads, asks Research, and posts the draft. */
function seedGroup(spade: FakeSpadeApi, at: number): void {
  const group = spade.teams.addGroup({
    id: "launch",
    name: "Launch team",
    members: ["spade", "research", "notes"].map((id) => spade.teams.member(id)),
    last_activity: at,
  });
  const spadeBot = { id: "spade", name: "Spade" };
  const research = { id: "research", name: "Research" };
  const said = (text: string, from?: { id: string; name: string }) =>
    spade.store(group.conversation, { type: "group_message", run: "r1", text, from });
  said("Plan the launch post for Friday");
  said("I'll ask Research for this week's numbers.", spadeBot);
  spade.store(group.conversation, {
    type: "group_asked",
    run: "r1",
    ask: "a1",
    by: spadeBot,
    to: research,
  });
  said("Installs are up 18% on last week, mostly from the share sheet.", research);
  spade.store(group.conversation, {
    type: "group_answered",
    run: "r1",
    ask: "a1",
    to: research,
    outcome: "answered",
  });
  said("Here's a draft: **ace on iPhone** now shares straight from any app.", spadeBot);
  said("Want me to post it Friday morning?", spadeBot);
  group.last_message = {
    from: "agent",
    text: "Want me to post it Friday morning?",
    at,
    agent: { ...spadeBot, machine: null },
  };
}

export function spadeScenario(daemon: FakeDaemon, scenario: SpadeScenario): void {
  if (scenario === "hold" || scenario === "release" || scenario === "on") {
    release?.();
    release = scenario === "hold" ? api?.holdQuestionSettles() : undefined;
    if (scenario !== "on") return;
  }
  if (scenario === "off" || scenario === "on") {
    daemon.services.settings.write("beta.spade", scenario === "on");
    // Back on, Spade runs again, as the daemon starts it.
    if (scenario === "on") {
      daemon.spade.setStatus({ state: "ready", version: "0.6.0" });
      reseed();
    }
    return;
  }
  const notes = api?.agents.find((agent) => agent.id === "notes");
  if (!api || !notes) return;
  api.store(notes.conversation, { type: "reply_started", reply: "r-live" });
  api.status(notes, "working", "Writing");
  daemon.spade.emit(`/v1/conversations/${notes.conversation}/live`, "delta", {
    reply: "r-live",
    text: "Looking at today's ",
  });
}

/**
 * Builder and Planner ask again once answered, Notes' streamed reply finishes, and a key or bot
 * a test added goes.
 */
function reseed(): void {
  if (api) {
    // In place: parts of the fixture hold this very list, so a new one would leave them behind.
    for (let at = api.agents.length - 1; at >= 0; at--)
      if (!seeded.has(api.agents[at]?.id ?? "")) api.agents.splice(at, 1);
    seedSetup(api);
  }
  const builder = api?.agents.find((agent) => agent.id === "builder");
  const notes = api?.agents.find((agent) => agent.id === "notes");
  if (!api) return;
  const planner = api.agents.find((agent) => agent.id === "planner");
  if (planner && planner.state !== "waiting") api.card(planner, `q-trip-${++planning}`, trip);
  if (builder && builder.state !== "waiting") {
    api.store(builder.conversation, { type: "reply_finished", reply: asking, text: "" });
    asking = `r-builder-${++asks}`;
    api.ask(builder, `call-tests-${asks}`, "shell", tests, asking);
  }
  if (notes && notes.state === "working") {
    api.store(notes.conversation, {
      type: "reply_finished",
      reply: "r-live",
      text: "Looking at today's ",
    });
    api.status(notes, "idle", null);
  }
}
