import type { BotFace } from "@ace/ui-core/bot-face";

/*
 * Every word on the Spade page (/spade/), and the cast that acts it out: Spade and four sample
 * bots, each with one face and one job across the page. The middle of the page walks through
 * Spade's features one at a time beside a drawn Spade messenger the bots act each one out in.
 * Claims stay to what ships (docs/design/spade.md, spade/docs, the Spade ADRs); Spade
 * is in beta and off until switched on in Settings › Beta.
 */

export const spadePage = {
  title: "Spade: an AI assistant with bots, memory and routines: ace",
  description:
    "Spade is a messenger for bots that work for you: each with a face, a task, a model and a machine. Your own models, on your own computer. In beta in ace.",
  status: "In beta",
  headline: "Bots that work for you, on your computer.",
  intro:
    "Spade is ace's own assistant: a messenger where you talk to Spade and to bots you make, each with a face, a task, a model and a machine.",
  turnOnLink: "How to turn it on",
} as const;

const face = (fields: Partial<BotFace> & Pick<BotFace, "body" | "pair">): BotFace => ({
  ears: "none",
  marking: "none",
  eyes: "egg",
  mouth: "none",
  cheeks: "none",
  accessory: "none",
  ...fields,
});

/** The page's cast. Spade draws with its own mark; the rest are character faces. */
export const cast = {
  spade: {
    name: "Spade",
    job: "The main bot. Always here.",
    face: face({ body: "round", pair: "stone" }),
  },
  flights: {
    name: "Flights",
    job: "Finds and books flights. Asks before paying.",
    face: face({ body: "bird", pair: "sky", eyes: "round" }),
  },
  inbox: {
    name: "Inbox",
    job: "Writes and sends your mail.",
    face: face({ body: "fox", pair: "ember", eyes: "almond" }),
  },
  papers: {
    name: "Papers",
    job: "Reads the research so you don't have to.",
    face: face({ body: "pebble", pair: "sage", eyes: "round", accessory: "glasses" }),
  },
  builds: {
    name: "Builds",
    job: "Watches the nightly build.",
    face: face({ body: "bot", pair: "stone", eyes: "bead" }),
  },
} as const;

export type CastName = keyof typeof cast;
export type BotName = Exclude<CastName, "spade">;

/** One feature of the walkthrough: its name, one sentence, and sometimes a short second line. */
export interface TourStep {
  id: string;
  title: string;
  body: string;
}

/** The walkthrough beside the drawn messenger (components/spade/Tour.astro), one feature a step. */
export const tour = {
  label: "Spade's features",
  index: "Spade's features",
  steps: [
    {
      id: "bots",
      title: "Bots you make",
      body: "Each bot has a face, a task, a model and a computer it lives on. Spade is the main one, and always there.",
    },
    {
      id: "clubs",
      title: "Clubs",
      body: "Put 2 to 8 bots in a group chat with a lead. The lead hands the parts out; @Name goes straight to one bot.",
    },
    {
      id: "on-its-own",
      title: "It works on its own",
      body: "A bot writes down what done means, works through a plan, and calls it done only once a separate check agrees. No step count or clock cuts it off.",
    },
    {
      id: "computer",
      title: "Its own computer",
      body: "A browser, the screen, a terminal and files of its own, live beside the chat. Work alongside it, or take over and hand back.",
    },
    {
      id: "memory",
      title: "Memory",
      body: "Short notes you can read and change, with About you shared by every bot, and a record of what it learned on past jobs.",
    },
    {
      id: "routines",
      title: "Routines and waking",
      body: "Work on a schedule, on an ace event, from a webhook or on a heartbeat. In between, a bot sleeps until a time or until something happens.",
    },
    {
      id: "skills-apps",
      title: "Skills, plugins and apps",
      body: "A bot proposes skills you can keep, uses the plugins you turn on for it, and reaches only the apps you hand it.",
    },
    {
      id: "research",
      title: "Files, voice and research",
      body: "PDF, Word, Excel and CSV in, images out, dictation and read-aloud. Research runs in the background with helpers and comes back cited; bigger jobs can start other bots and ace agents.",
    },
    {
      id: "digests",
      title: "Digests",
      body: "What moved, what each bot decided and why, and what waits on you, built from its own record.",
    },
    {
      id: "models",
      title: "Your models, your machine",
      body: "Any endpoint with your key in the OS keychain, or a coding CLI you're signed in to, and a model per job. Spade runs on your computer, never hosted.",
    },
    {
      id: "sandbox",
      title: "Sandbox and review",
      body: "Commands run in a sandbox: the bot's folder, none of your passwords, the network through Spade's proxy. What reaches outside is checked first.",
    },
    {
      id: "yours",
      title: "Always yours",
      body: "Paying, sending as you and changing access always come to you as a request. Questions come as a card you can answer later.",
    },
  ] satisfies TourStep[],
} as const;

/** The words drawn in the walkthrough's messenger. */
export const scene = {
  composer: "Message",
  profile: ["Details", "Library", "Computer"],
  details: [
    ["Task", "Finds and books flights. Asks before paying."],
    ["Model", "anthropic/claude-sonnet-5-5"],
    ["Machine", "This Mac"],
    ["Routines", "Fare check, daily at 8:00"],
  ],
  flights: {
    hello: "I'm Flights. I find flights, and I ask before I pay.",
    ask: "Find me a flight to Lisbon on the 12th, under $300, window seat.",
    working: "Comparing fares on three sites",
    computer: "That's my browser. Take over whenever you like.",
    remember: "You always pick the window. Shall I remember that?",
    model: "I think with whichever model you pick for me.",
    found: "Nonstop at 7:40, $268, seat 23A. Your call.",
  },
  club: {
    name: "Lisbon talk",
    ask: "I'm speaking in Lisbon on the 12th. Sort it out.",
    lead: "Flights takes the flight, Papers the reading.",
    handoffs: ["Spade asked Flights", "Spade asked Papers"],
    flights: "TAP, Friday 7:40, $268. Seat 23A is free.",
    mention: "@Papers anything good to read on the way?",
    papers: "Two short ones on speaking nerves. Both in our Library.",
  },
  builds: {
    plan: [
      ["1  Reproduce the failing test", "Verified"],
      ["2  Fix the date parser", "Verified"],
      ["3  Run the full suite", "Checking"],
    ],
    progress: "2 of 3 verified · working for 3 h 12 min",
    onItsOwn: "I don't call it done until something else checks.",
    routine: "Nightly build · 2:00 AM",
    sleeping: "Sleeping until 14:05: deploy settles",
    routines: "I start at 2:00 whether or not you're up.",
    digest: {
      title: "Digest · 8:00 AM",
      rows: [
        ["Progress", "Nightly build passed"],
        ["Decided", "Retried the flaky test once: it failed on a timeout"],
        ["Waiting on you", "Nothing"],
      ],
    },
    digestSays: "Decided: retry the flaky test once, not skip it.",
    steps: "Ran 4 commands in its sandbox",
    blocked: "Blocked example.com: not on the network list",
    outside: {
      title: "Run this outside the sandbox?",
      command: "brew install ffmpeg",
      deny: "Deny",
      always: "Always for this bot",
      once: "Allow once",
    },
    sandbox: "My commands stay in my box.",
  },
  routines: [
    ["Nightly build", "Daily at 2:00"],
    ["When a thread needs you", "On an ace event"],
    ["New release", "Webhook"],
    ["Check the deploy", "Every 30 minutes"],
  ],
  inbox: {
    skill: "I worked out how you like replies written. Keep it as a skill?",
    skillName: "reply-like-me",
    skillBody: "Short, warm, no sign-off. Answers the question first.",
    discard: "Discard",
    save: "Save",
    apps: [
      ["Notion", "Allowed"],
      ["Linear", "Allowed"],
      ["Stripe", "Not for this bot"],
    ],
    plugins: "Plugins: 1 on for Inbox",
  },
  papers: {
    ask: "Read this before my talk.",
    file: "sleep-study.pdf",
    fileMeta: "40 pages",
    helper: "Helper looking into: six papers on speaking nerves",
    researching: "Researching · 14 sources read",
    report: "research/lisbon-talk.md",
    reportMeta: "Report, 23 sources",
    says: "23 sources. Two disagree, and I said where.",
  },
  library: {
    note: "Prefers a window seat.",
    keep: "Keep",
    dismiss: "Dismiss",
    notes: [
      ["Lives in Berlin; flies from BER.", "About you"],
      ["Fares drop on Tuesdays.", "Flights"],
    ],
  },
  picker: [
    { name: "Anthropic", note: "Your key", models: ["claude-sonnet-5-5", "claude-haiku-5-5"] },
    { name: "Ollama", note: "On this Mac", models: ["qwen3-coder"] },
    { name: "Claude Code", note: "Your subscription", models: ["claude-opus-5-5"] },
  ],
  pay: {
    title: "Pay $268 to TAP Air Portugal?",
    body: "Berlin to Lisbon, the 12th, 7:40, seat 23A.",
    deny: "Deny",
    allow: "Allow",
  },
} as const;

/** The toy: make a face. Nothing is created here. */
export const maker = {
  heading: "Make one.",
  lines: ["Pick a face. In the app it works the same, then you give it a job."],
  shuffle: "Shuffle",
  name: "Name",
  task: "Task",
  taskPlaceholder: "What should it do?",
  note: "A toy: nothing is saved. New bot in Spade starts the same way.",
} as const;

/** Turning Spade on. */
export const turnOn = {
  heading: "Switch me on.",
  lines: ["I'm in every copy of ace, off until you say so."],
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
      "Work in its own folder: run commands in its sandbox, read the web, keep notes. Publishing and commands outside the sandbox are reviewed first. Paying, sending anything as you and changing access always ask you.",
  },
  {
    question: "What is a club?",
    answer:
      "A group chat of 2 to 8 of your own bots with a lead. The lead hands parts of the job to the others, and @Name sends a message straight to one of them.",
  },
  {
    question: "How do I turn Spade on?",
    answer:
      "Spade is in beta. In ace, open Settings › Beta and turn on Spade, then give it a model in Settings › Spade.",
  },
] as const;
