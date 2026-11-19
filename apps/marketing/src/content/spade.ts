import type { BotFace } from "@ace/ui-core/bot-face";

/*
 * Every word on the Spade page (/spade/), and the bots its drawings show. Keep it to what ships
 * in Spade today (docs/design/spade.md, spade/docs and the Spade ADRs); Spade is in beta and off
 * until switched on in Settings › Beta.
 */

export const spadePage = {
  title: "Spade: ace's own assistant",
  description:
    "Spade is a messenger for bots that work for you: each with a face, a task, a model and a machine. Your own models, on your own computer. In beta in ace.",
  status: "In beta",
  headline: "Bots that work for you, on your computer.",
  intro:
    "Spade is ace's own assistant: a messenger where you talk to Spade and to bots you make, each with a face, a task, a model and a machine.",
  turnOnLink: "How to turn it on",
} as const;

/** A bot as the drawings show it: its face, its name and one line in the list. */
export interface DrawnBot {
  name: string;
  face: BotFace;
}

const face = (fields: Partial<BotFace> & Pick<BotFace, "body" | "pair">): BotFace => ({
  ears: "none",
  marking: "none",
  eyes: "egg",
  mouth: "none",
  cheeks: "none",
  accessory: "none",
  ...fields,
});

export const bots = {
  flights: {
    name: "Flights",
    face: face({ body: "bird", pair: "sky", eyes: "round", mouth: "smile" }),
  },
  inbox: {
    name: "Inbox",
    face: face({ body: "fox", pair: "ember", ears: "cat", eyes: "almond" }),
  },
  papers: {
    name: "Papers",
    face: face({ body: "pebble", pair: "sage", eyes: "round", accessory: "glasses" }),
  },
  builds: {
    name: "Builds",
    face: face({ body: "bot", pair: "stone", eyes: "bead" }),
  },
} satisfies Record<string, DrawnBot>;

/** The conversation the page plays: asked, works, answers, then asks before it pays. */
export const conversation = {
  heading: "Ask once. It gets on with it.",
  lede: "A bot works on its own, in its own browser and terminal, and comes back when it has an answer or needs your say.",
  ask: "Find me a flight to Lisbon on the 12th, under $300, with a window seat.",
  working: "Comparing fares on three sites",
  workingTime: "0:42",
  answer: "TAP has a nonstop at 7:40 for $268, and window seat 23A is free. Shall I book it?",
  steps: "Opened 6 pages, filled 1 form",
  yes: "Yes, book it.",
  card: {
    title: "Pay $268 to TAP Air Portugal?",
    body: "One adult, Berlin to Lisbon on the 12th, 7:40, seat 23A.",
    deny: "Deny",
    allow: "Allow",
  },
  composer: "Message Flights",
  list: {
    flights: "Pay $268 to TAP Air Portugal?",
    inbox: "Sorting 41 new emails",
    papers: "Found 12 papers on sleep and memory",
    builds: "Nightly build passed",
    spade: "Your week is clear after Thursday.",
    you: "You",
  },
  profile: {
    tabs: ["Details", "Library", "Computer"],
    rows: [
      { label: "Task", value: "Finds and books flights. Asks before paying." },
      { label: "Model", value: "anthropic/claude-sonnet-5-5" },
      { label: "Machine", value: "This Mac" },
      { label: "Routines", value: "Fare check, daily at 8:00" },
    ],
  },
} as const;

/** What every bot has, as a list beside its detail. */
export const kit = {
  heading: "What a bot has.",
  lede: "Spade is always there, and every other bot is one you make. Each has these of its own.",
  items: [
    {
      key: "memory",
      name: "Memory",
      line: "Notes you can read and change.",
      body: "A bot saves short notes as it learns. Its own are for its job; About you is shared by every bot. Open its Library to edit or delete any of them.",
    },
    {
      key: "routines",
      name: "Routines",
      line: "Work that starts without you.",
      body: "On a schedule, when an agent thread finishes or needs you, or when a webhook calls. Each run lands in the bot's own conversation.",
    },
    {
      key: "skills",
      name: "Skills",
      line: "What it learns, kept.",
      body: "After a long task or a correction, a bot can propose a skill. Save it and it joins ace's library, for every bot and every agent.",
    },
    {
      key: "apps",
      name: "Apps",
      line: "The apps you already use.",
      body: "Bots reach your apps through the makers' own MCP servers, signed in from Spade on your computer. A new bot gets none until you turn some on.",
    },
    {
      key: "computer",
      name: "Its computer",
      line: "Watch it work. Take over.",
      body: "A browser, the screen, a terminal and a folder of its own. What it uses shows live beside the chat, and you can take over while it drives.",
    },
  ],
} as const;

/** Section 3's small drawings: what each detail shows. */
export const kitDrawings = {
  memory: {
    notes: [
      { scope: "About you", text: "Prefers a window seat." },
      { scope: "About you", text: "Lives in Berlin; flies from BER." },
      { scope: "Flights", text: "TAP and Lufthansa fares drop on Tuesdays." },
    ],
    suggested: { text: "Likes a hotel near the old town.", keep: "Keep", dismiss: "Dismiss" },
  },
  routines: [
    { name: "Fare check", when: "Daily at 8:00" },
    { name: "When a thread needs you", when: "On an ace event" },
    { name: "New booking email", when: "Webhook" },
  ],
  skill: {
    say: "I worked out how you like trips planned. Keep it as a skill?",
    name: "plan-a-trip",
    description: "Window seats, nonstop first, a hotel near the old town.",
    discard: "Discard",
    save: "Save",
  },
  apps: [
    { name: "Calendar", state: "Signed in" },
    { name: "Notes", state: "Signed in" },
    { name: "Issues", state: "Not for this bot" },
  ],
  computer: {
    surfaces: ["Browser", "Screen", "Terminal", "Files"],
    url: "flytap.com/booking",
    fields: ["Jordan Rivera", "23A, window"],
    activity: "Filling in the passenger form",
    takeOver: "Take over",
  },
} as const;

/** Section 4: models and where Spade runs. */
export const yours = {
  heading: "Your models. Your machine.",
  lede: "Spade runs as its own service on your computer, never hosted. Each bot thinks with the model you pick for it.",
  caption: "Keys stay in your OS keychain. CLIs keep their own logins.",
  rows: [
    {
      name: "Any endpoint",
      body: "Anything that speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, local servers included.",
    },
    {
      name: "Your subscriptions",
      body: "Or a coding CLI you are already signed in to. Spade goes through the CLI and never reads its login.",
    },
    {
      name: "Keys in your keychain",
      body: "An endpoint's key goes to the OS keychain and nowhere else: not a file, not a log, not the relay.",
    },
    {
      name: "A machine per bot",
      body: "Each bot lives on the computer you pick, with that computer's files and browser.",
    },
  ],
  picker: {
    label: "Model",
    groups: [
      {
        name: "Anthropic",
        note: "Your key",
        models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
      },
      { name: "Ollama", note: "On this Mac", models: ["qwen3-coder"] },
      { name: "Claude Code", note: "Your subscription", models: ["claude-opus-5-5"] },
    ],
    chosen: "claude-sonnet-5-5",
  },
} as const;

/** Section 5: what keeps a bot in bounds. */
export const safety = {
  heading: "It asks before it pays or speaks for you.",
  lede: "A bot gets on with its work inside a sandbox. What leaves the box is checked, and the things only you should decide come to you.",
  rows: [
    {
      name: "A sandbox for its commands",
      body: "They write only to the bot's folder and folders you grant, read none of your sign-ins, and reach the network only through Spade's proxy.",
    },
    {
      name: "A second look",
      body: "Publishing, and anything run outside the sandbox, goes past a reviewer model first. A refused step goes back to the bot.",
    },
    {
      name: "Always yours",
      body: "Paying, and sending a message or comment as you, always come to you as a request.",
    },
  ],
} as const;

/** Section 6: turning Spade on. */
export const turnOn = {
  heading: "Turn it on.",
  lede: "Spade ships in every copy of ace and stays off until you switch it on.",
  steps: [
    { name: "Switch it on", body: "In ace, open Settings › Beta and turn on Spade." },
    {
      name: "Give it a model",
      body: "Add an endpoint with your key, or pick a coding CLI you are signed in to.",
    },
    { name: "Say hello", body: "Talk to Spade, or press + for a new bot with a task of its own." },
  ],
} as const;

export const spadeQuestions = [
  {
    question: "Does Spade cost anything?",
    answer:
      "Spade is part of ace, which is free and open source. The models are yours: you pay your own endpoint, or use a coding CLI subscription you already have. Spade shows what each bot spent, and has no limits of its own.",
  },
  {
    question: "Does Spade run in the cloud?",
    answer:
      "No. Spade runs as its own service on your computer, beside ace, and listens only on that machine. Each bot lives on the computer you choose for it.",
  },
  {
    question: "Where are my API keys kept?",
    answer:
      "In your operating system's keychain: Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux. A key is never written to a file, a log or ace's relay, and no app can read it back.",
  },
  {
    question: "What can a bot do without asking me?",
    answer:
      "Work in its own folder: run commands in its sandbox, read the web, keep notes. Publishing and commands outside the sandbox are reviewed first. Paying and sending anything as you always ask you.",
  },
  {
    question: "How do I turn Spade on?",
    answer:
      "Spade is in beta. In ace, open Settings › Beta and turn on Spade, then give it a model in Settings › Spade.",
  },
] as const;
