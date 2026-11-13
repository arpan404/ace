import { FakeSpadeApi, type FakeDaemon } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`: Spade running on This Mac with its bots, mid-trip-planning, and a bot on the
 * build server, so the Spade place shows every state the person meets: Spade at work, a bot
 * waiting on an approval, an idle bot, a message from another bot, and the working line.
 */
export function seedFakeSpade(daemon: FakeDaemon, server: FakeDaemon) {
  const now = Date.now();
  const minutes = (count: number) => now - count * 60_000;
  const here = running(daemon);
  const endpoint = {
    id: "openrouter",
    name: "OpenRouter",
    format: "openai-chat",
    base_url: "https://openrouter.ai/api/v1/",
    header_names: [],
    session_header: null,
    needs_key: true,
    key_set: true,
    key_source: "keychain",
    models: [
      {
        id: "anthropic/claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        context: 200_000,
        capabilities: ["images", "tools"],
        source: "typed",
      },
    ],
  };
  here.endpoints.push(endpoint);
  // The person's subscriptions, as ace lists them (ADR 0133).
  here.subscriptions = [
    {
      provider: "codex",
      name: "Codex",
      accounts: [
        { id: "work", label: "Work" },
        { id: "personal", label: "Personal" },
      ],
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        { id: "gpt-6.1-luna", name: "GPT-6.1 Luna" },
      ],
    },
    {
      provider: "claude",
      name: "Claude Code",
      accounts: [{ id: "claude-cli-default", label: null }],
      models: [{ id: "opus-5.5", name: "Opus 5.5" }],
    },
  ];
  here.liveModels.set("openrouter", [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      context: 200_000,
      capabilities: ["images", "tools"],
    },
    {
      id: "anthropic/claude-haiku-5.5",
      name: "Claude Haiku 5.5",
      context: 200_000,
      capabilities: ["images", "tools"],
    },
    {
      id: "openai/gpt-6.1-mini",
      name: "GPT-6.1 Mini",
      context: 400_000,
      capabilities: ["images", "tools"],
    },
    { id: "meta/llama-4-scout", name: "Llama 4 Scout", context: 128_000 },
  ]);
  here.presets.push({
    id: "opencode-go",
    name: "OpenCode Go",
    format: "openai-chat",
    base_url: "https://opencode.ai/zen/go/v1/",
    key_env: "OPENCODE_API_KEY",
    session_header: "x-opencode-session",
  });
  seedConnectors(here);
  const spade = here.addAgent({
    id: "spade",
    kind: "main",
    name: "Spade",
    avatar: { kind: "spade" },
    model: "openrouter/anthropic/claude-sonnet-5.5",
    created_at: minutes(60 * 24 * 30),
    last_activity: now,
  });
  const inbox = here.addAgent({
    id: "inbox",
    name: "Inbox",
    avatar: {
      kind: "character",
      v: 1,
      body: "ghost",
      pair: "mint",
      ears: "none",
      marking: "none",
      eyes: "sleepy",
      mouth: "smile",
      cheeks: "blush",
      accessory: "headphones",
    },
    last_activity: minutes(11),
  });
  const notes = here.addAgent({
    id: "notes",
    name: "Release notes",
    avatar: {
      kind: "character",
      v: 1,
      body: "bot",
      pair: "stone",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "none",
      cheeks: "none",
      accessory: "none",
    },
    last_activity: minutes(44),
  });
  const garden = here.addAgent({
    id: "garden",
    name: "Garden",
    model: "cli:codex@work/gpt-6.1-sol",
    problem: "Codex is signed out. Sign in to it in ace, then send again.",
    avatar: {
      kind: "character",
      v: 1,
      body: "sprout",
      pair: "mint",
      ears: "none",
      marking: "none",
      eyes: "egg",
      mouth: "smile",
      cheeks: "blush",
      accessory: "none",
    },
    last_activity: minutes(60 * 20),
    last_message: {
      from: "person",
      text: "Water the tomatoes at 6 tonight",
      at: minutes(60 * 20),
      from_agent: null,
    },
  });
  // A group of three, one of them working, and templates to start a bot from.
  here.teams.addGroup({
    id: "launch",
    name: "Launch crew",
    members: [notes, inbox, garden].map((bot) => ({
      agent: bot.id,
      machine: null,
      name: bot.name,
      avatar: bot.avatar,
      away: false,
    })),
    last_activity: minutes(60),
  });
  here.teams.templates.push(
    template("research", "Research", "Finds and checks sources.", {
      body: "round",
      pair: "lagoon",
      marking: "muzzle",
      mouth: "smile",
      cheeks: "blush",
      accessory: "glasses",
    }),
    template("travel", "Travel", "Plans trips and watches fares.", {
      body: "fox",
      pair: "ember",
      eyes: "almond",
      mouth: "smile",
      accessory: "scarf",
    }),
    template("writing", "Writing", "Drafts and edits with you.", {
      body: "cloud",
      pair: "lilac",
      eyes: "big",
      mouth: "smile",
      cheeks: "blush",
      accessory: "flower",
    }),
  );
  const say = (text: string) => here.store(spade.conversation, { type: "user_message", text });
  say("Can you plan my Lisbon trip, the 14th to the 18th? Keep hotels under €180 a night.");
  here.reply(
    spade,
    "Here's a first pass:\n- **Flights**: TAP `TP1351` on the 14th, back on the 18th\n- **Hotels**: three near Chiado, all under €180\n- **Day 2**: Sintra by train from Rossio\n\nThe whole plan is in [lisbon-trip.md](https://example.com/lisbon-trip.md).",
  );
  say("Which trains should I take to Sintra?");
  here.reply(
    spade,
    "They leave Rossio every 20 minutes. The first two that get you there before the palace opens:\n```\n09:11  Rossio → Sintra  arr 09:51\n09:31  Rossio → Sintra  arr 10:11\n```",
  );
  here.store(spade.conversation, {
    type: "user_message",
    text: "TAP sent the booking confirmation for TP1351. Reference `QX7K2P`.",
    from_agent: { id: "inbox", name: "Inbox", depth: 1 },
  });
  say("Great. Book the cheapest of the three hotels.");
  here.store(spade.conversation, { type: "reply_started", reply: "r-now" });
  here.status(spade, "working", "Comparing hotel prices");
  spade.last_message = {
    from: "person",
    text: "Great. Book the cheapest of the three hotels.",
    at: now,
    from_agent: null,
  };

  // Inbox's routines (ADR 0129): its morning sweep fired today, then the person wrote.
  here.store(inbox.conversation, {
    type: "user_message",
    text: "Sweep the inbox and tell me what needs me today.",
    from_routine: { id: "rt-sweep", name: "Morning sweep", run: "run-1", label: "8:30" },
  });
  here.reply(
    inbox,
    "Two things need you: the landlord asked about the plumber, and the dentist moved you to Friday.",
  );
  for (const routine of [
    {
      name: "Morning sweep",
      instruction: "Sweep the inbox and tell me what needs me today.",
      trigger: { kind: "schedule", schedule: "weekdays at 8:30" },
    },
    {
      name: "Follow up on finished work",
      instruction: "Tell me what the thread changed.",
      trigger: { kind: "event", event: "thread_done" },
    },
  ])
    here.routines.agentRoute("POST", "inbox", "routines", routine);
  here.routines.heartbeats.set("inbox", {
    enabled: true,
    every_minutes: 30,
    checklist: "Anything from the bank or the landlord?",
    quiet: { start: "22:00", end: "07:00" },
    time_zone: "Europe/Lisbon",
    next_run: now + 12 * 60_000,
    last_run: null,
  });
  here.store(inbox.conversation, {
    type: "user_message",
    text: "Reply to the landlord that Thursday works for the plumber, any time after 2.",
  });
  here.reply(
    inbox,
    "Drafted it:\n\n“Hi Marta, Thursday works for the plumber. Any time after 2pm is fine. Thanks, Arpan”",
  );
  here.ask(inbox, "k-mail", "send_email");

  here.store(notes.conversation, { type: "user_message", text: "Draft the notes for v0.0.21." });
  here.store(notes.conversation, { type: "reply_started", reply: "r-notes" });
  here.status(notes, "working", "Reading the merged pull requests");

  // Flights watches fares: two replies in a run, then a reply that couldn't reach the endpoint.
  const flights = here.addAgent({
    id: "flights",
    name: "Flights",
    avatar: {
      kind: "character",
      v: 1,
      body: "fox",
      pair: "ember",
      ears: "none",
      marking: "stripes",
      eyes: "almond",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
    last_activity: minutes(3),
  });
  here.store(flights.conversation, {
    type: "user_message",
    text: "Watch fares to Lisbon for the 14th.",
  });
  here.reply(flights, "Watching TAP and easyJet from the 14th.");
  here.reply(flights, "Cheapest so far: €212 return on TAP, leaving 07:40.");
  here.store(flights.conversation, { type: "user_message", text: "Check again now." });
  here.store(flights.conversation, { type: "reply_started", reply: "r-flights" });
  here.store(flights.conversation, {
    type: "reply_failed",
    reply: "r-flights",
    text: "",
    error:
      "openrouter/anthropic/claude-sonnet-5.5: Web stream error for model 'anthropic/claude-sonnet-5.5'. Cause: error sending request for url (https://openrouter.ai/api/v1/chat/completions)",
    kind: "unreachable",
    endpoint: "openrouter",
  });

  // Garden learned how the person waters, and keeps its log in its files (ADR 0130).
  here.store(garden.conversation, {
    type: "user_message",
    text: "Water the tomatoes at 6 tonight",
  });
  here.store(garden.conversation, { type: "reply_started", reply: "r-garden" });
  here.store(garden.conversation, {
    type: "step_finished",
    reply: "r-garden",
    text: "",
    calls: [{ id: "g-skill", name: "skill_propose" }],
  });
  here.store(garden.conversation, { type: "tool_started", reply: "r-garden", call_id: "g-skill" });
  here.store(garden.conversation, {
    type: "tool_finished",
    reply: "r-garden",
    call_id: "g-skill",
    content: "Proposed.",
  });
  here.store(garden.conversation, {
    type: "step_finished",
    reply: "r-garden",
    text: "Set for 6pm. I'll skip it if more than 5mm of rain falls first.",
  });
  here.store(garden.conversation, {
    type: "reply_finished",
    reply: "r-garden",
    text: "Set for 6pm. I'll skip it if more than 5mm of rain falls first.",
  });
  here.proposals.set("garden", [
    {
      id: "sp_garden",
      call_id: "g-skill",
      name: "watering",
      description: "Plan when to water the garden from the forecast",
      body: "# Watering\n\n1. Read tomorrow's forecast.\n2. Skip watering after more than 5mm of rain.\n3. Water in the evening, never at midday.\n",
      why: "You told me twice not to water after rain.",
      base: {
        id: "skl_watering",
        hash: "a",
        manual: false,
        description: "Plan when to water the garden from the forecast",
        body: "# Watering\n\n1. Read tomorrow's forecast.\n2. Water in the evening.\n",
      },
      state: "open",
      created_at: minutes(60 * 20),
    },
  ]);
  here.files.set("garden", {
    "log/2026-11.md": "# November\n\n- 11th: watered 6pm, 4L\n- 12th: skipped, 7mm rain\n",
    "log/2026-10.md": "# October\n\n- 30th: watered 6pm, 5L\n",
    "beds.md": "# Beds\n\nTomatoes: south bed\nBasil: pots by the door\n",
    "forecast.json": '{"tomorrow": {"rain_mm": 2}}',
  });

  const remote = running(server);
  remote.addAgent({
    id: "research",
    name: "Research",
    avatar: {
      kind: "character",
      v: 1,
      body: "blob",
      pair: "rose",
      ears: "cat",
      marking: "none",
      eyes: "big",
      mouth: "cat",
      cheeks: "blush",
      accessory: "none",
    },
    last_activity: minutes(60 * 24 * 2),
    last_message: {
      from: "agent",
      text: "Found 14 papers on battery recycling.",
      at: minutes(60 * 48),
      from_agent: null,
    },
  });
  remote.endpoints.push({ ...endpoint });
}

function running(daemon: FakeDaemon) {
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  daemon.services.settings.write("spade.enabled", true);
  return new FakeSpadeApi(daemon.spade, () => Date.now());
}

/** A few apps from the catalogue, two of them connected and one signed out (ADR 0131). */
function seedConnectors(spade: FakeSpadeApi) {
  spade.connectors.catalogue.push(
    {
      id: "asana",
      name: "Asana",
      url: "https://mcp.asana.com/v2/mcp",
      sign_in: ["oauth_client"],
      notes:
        "Asana does not register clients by itself: create an MCP app in Asana and enter its client ID and secret.",
    },
    {
      id: "github",
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp/",
      sign_in: ["token", "oauth_client"],
      notes:
        "A personal access token is simplest. Signing in needs a GitHub OAuth app you register.",
    },
    {
      id: "linear",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      sign_in: ["oauth", "token"],
      notes: "An API key also works.",
    },
    {
      id: "notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      sign_in: ["oauth", "token"],
      notes: "Workspace tokens are for Business and Enterprise plans.",
    },
    {
      id: "sentry",
      name: "Sentry",
      url: "https://mcp.sentry.dev/mcp",
      sign_in: ["oauth"],
      notes: "",
    },
  );
  spade.connectors.connectors.push(
    {
      id: "github",
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp/",
      catalogue: "github",
      sign_in: "token",
      state: "connected",
      tools: 41,
    },
    {
      id: "notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      catalogue: "notion",
      sign_in: "oauth",
      state: "needs_reconnect",
      account: "sam@example.com",
      tools: 12,
    },
  );
  spade.connectors.access.set("inbox", { all: false, connectors: ["notion"] });
}

/** A template with its own face, as Spade ships them. */
const template = (id: string, name: string, blurb: string, face: Record<string, string>) => ({
  id,
  name,
  blurb,
  task: blurb,
  face: { kind: "character", v: 1, ...face },
  model_kind: "capable",
  routines: [],
});
