import type { CliBotStarter } from "@ace/protocol/cli-outputs";

/*
 * What `ace bot init` writes (ADR 0200 §3.1, §9): a version 3 package that passes `ace bot check`
 * and `ace bot test` as written. Plain JSON with no comments, since bot.json is read as JSON;
 * the README says what each file is for. Pure: a name and a starter in, files out.
 */

export interface ScaffoldFile {
  readonly path: string;
  readonly text: string;
}

/** A name as a folder and a market entry: lowercase letters, digits and hyphens. */
export function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

interface Starter {
  readonly blurb: string;
  readonly task: string;
  readonly model: "fast" | "capable";
  readonly triggers: readonly unknown[];
  readonly effects: readonly { effect: string; why: string }[];
  readonly card: { title: string; blocks: unknown[] };
  readonly message: string;
  readonly reply: string;
  readonly skill: string;
  readonly more?: (name: string) => ScaffoldFile[];
  /** A panel it ships (ADR 0200 §5.2): its declaration and its one page. */
  readonly panel?: { readonly declared: Record<string, unknown>; readonly page: string };
}

/** The watcher's panel: what it watches, each with a Stop button that tells the bot. */
const watchPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Watching</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.45 var(--font-sans, system-ui); color: var(--foreground); }
  h1 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .value { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  button { font: inherit; color: var(--foreground); background: transparent; border: 1px solid var(--border); border-radius: var(--radius, 6px); padding: 3px 10px; cursor: pointer; }
  button:hover { background: var(--hover); }
  .empty { color: var(--muted-foreground); }
</style>
</head>
<body>
<h1>Watching</h1>
<ul id="items"></ul>
<p class="empty" id="empty">Nothing yet. Tell the bot what to watch.</p>
<script>
  // ace sends this page its state (what the bot set with panel_update) and the person's theme;
  // acePanel.act sends one of the actions bot.json declares back to the bot.
  const list = document.getElementById("items");
  const empty = document.getElementById("empty");
  function row(item) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = item.value || "";
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.addEventListener("click", () => acePanel.act("stop_watching", item.name));
    li.append(name, value, stop);
    return li;
  }
  function show(state) {
    const items = (state && state.items) || [];
    list.replaceChildren(...items.map(row));
    empty.hidden = items.length > 0;
  }
  addEventListener("ace:state", (event) => show(event.detail));
  show(acePanel.state);
</script>
</body>
</html>
`;

function starter(name: string, kind: CliBotStarter): Starter {
  switch (kind) {
    case "blank":
      return {
        blurb: `${name} helps with what you write to it.`,
        task: `You are ${name}. Help the person with what they ask, briefly. Keep what they tell you to remember in your notes.`,
        model: "fast",
        triggers: [{ kind: "message" }],
        effects: [],
        card: {
          title: "Done",
          blocks: [{ kind: "list", items: ["What you asked, done."] }],
        },
        message: "Remember that I like short answers.",
        reply: "Noted: short answers from now on.",
        skill: "How to answer: short, plain words, the answer first.",
      };
    case "watcher":
      return {
        blurb: `${name} checks something for you every morning and says when it changes.`,
        task: `You are ${name}. Keep what the person asks you to watch in your notes. When your routine fires, check each one, and tell the person only about a real change, with a card.`,
        model: "fast",
        triggers: [
          { kind: "message" },
          {
            kind: "schedule",
            name: "Morning check",
            instruction: "Check everything you watch. Tell me only what changed.",
            schedule: "daily at 7:00",
          },
        ],
        effects: [
          {
            effect: "network",
            why: "Reads the pages and apps you ask it to watch.",
          },
        ],
        card: {
          title: "Something changed",
          blocks: [
            { kind: "metric", label: "Price", value: "182", unit: "USD", change: "-24" },
            {
              kind: "actions",
              actions: [
                { kind: "choose", id: "keep", label: "Keep watching" },
                { kind: "choose", id: "stop", label: "Stop watching" },
              ],
            },
          ],
        },
        message: "Watch the price of the blue kettle.",
        reply: "I'll watch the blue kettle and tell you when its price changes.",
        skill:
          "How to watch: keep each thing's last value in your notes, and compare with it. After each check, set your Watching panel with panel_update.",
        panel: {
          declared: {
            id: "watching",
            kind: "panel",
            file: "panels/watching/index.html",
            title: "Watching",
            state: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  maxItems: 50,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", maxLength: 80 },
                      value: { type: "string", maxLength: 40 },
                    },
                    required: ["name"],
                  },
                },
              },
              required: ["items"],
            },
            actions: [
              {
                name: "stop_watching",
                label: "Stop watching",
                value: { type: "string", maxLength: 80 },
              },
            ],
          },
          page: watchPage,
        },
        more: () => [
          {
            path: "tests/morning-check.json",
            text: json({
              name: "The morning check says nothing changed",
              given: { trigger: "Morning check" },
              model: [{ say: "Nothing changed this morning." }],
              expect: { reply_contains: ["nothing changed"] },
            }),
          },
          {
            path: "tests/panel.json",
            text: json({
              name: "Sets its Watching panel",
              given: { message: "Watch the price of the blue kettle." },
              model: [
                {
                  calls: [
                    {
                      tool: "panel_update",
                      arguments: {
                        surface: "watching",
                        data: { items: [{ name: "Blue kettle", value: "39 USD" }] },
                      },
                    },
                  ],
                },
                { say: "Watching the blue kettle." },
              ],
              expect: { calls: ["panel_update"], reply_contains: ["blue kettle"] },
            }),
          },
        ],
      };
    case "club-member":
      return {
        blurb: `${name} answers when someone mentions it in a thread or a club.`,
        task: `You are ${name}, a member of the person's clubs. Answer when you're mentioned, in a few lines, and stay on what you were asked.`,
        model: "capable",
        triggers: [{ kind: "message" }, { kind: "mention", in: ["threads", "clubs"] }],
        effects: [],
        card: {
          title: "My answer",
          blocks: [{ kind: "list", items: ["One point.", "Another point."] }],
        },
        message: "What do you think of the plan?",
        reply: "The plan holds: two points to check first.",
        skill: "How to answer in a club: a few lines, your view first, then why.",
      };
  }
}

/** The files of a new package named `name`, from `kind`. */
export function scaffold(name: string, kind: CliBotStarter): ScaffoldFile[] {
  const slug = slugOf(name);
  const it = starter(name, kind);
  const skill = `skills/${slug}`;
  const card = `cards/${slugOf(it.card.title) || "card"}.json`;
  const more = it.more?.(name) ?? [];
  const tests = ["tests/first-message.json", ...more.map((file) => file.path)];
  const bot = {
    format: "spade-bot",
    version: 3,
    requires: { runtime: "1" },
    name,
    blurb: it.blurb,
    task: it.task,
    model: it.model,
    triggers: it.triggers,
    skills: [skill],
    effects: it.effects,
    ...(it.panel ? { surfaces: [it.panel.declared] } : {}),
    tests,
    pricing: { kind: "free" },
  };
  const first = {
    name: "Answers its first message and shows a card",
    given: { message: it.message },
    model: [
      { calls: [{ tool: "memory_save", arguments: { text: it.message } }] },
      { calls: [{ tool: "card_show", arguments: { data: it.card } }] },
      { say: it.reply },
    ],
    expect: {
      calls: ["memory_save", "card_show"],
      cards: [it.card.title],
      reply_contains: [it.reply.split(" ").slice(0, 2).join(" ")],
    },
  };
  const skillText = [
    "---",
    `name: ${slug}`,
    `description: What ${name} knows about its work. Read it before you start.`,
    "---",
    "",
    `# ${name}`,
    "",
    it.skill,
    "",
  ].join("\n");
  const readme = [
    `# ${name}`,
    "",
    it.blurb,
    "",
    "An agent package for Spade (format `spade-bot`, version 3). Its listing shows this page.",
    "",
    "## Files",
    "",
    "- `bot.json`: the manifest: name, task, triggers, the effects it may use and why, its tests.",
    `- \`${skill}/SKILL.md\`: a skill only this bot uses.`,
    `- \`${card}\`: a card the bot shows with \`card_show\`, as data ace draws.`,
    ...(it.panel
      ? [
          `- \`${String(it.panel.declared["file"])}\`: its panel, a page beside its conversation on the web and desktop. The bot sets what it shows with \`panel_update\`; its Stop button sends \`stop_watching\` back.`,
        ]
      : []),
    ...tests.map((test) => `- \`${test}\`: a scenario test, run offline by \`ace bot test\`.`),
    "",
    "## Working on it",
    "",
    "```",
    "ace bot check      the market's checks, every problem at its place",
    "ace bot test       its scenarios on Spade's engine with a scripted model, offline",
    "ace bot dev        install it here as a development bot, updated on every save",
    "ace bot publish    check, test, then publish it free",
    "```",
    "",
  ].join("\n");
  return [
    { path: "bot.json", text: json(bot) },
    { path: "README.md", text: readme },
    { path: `${skill}/SKILL.md`, text: skillText },
    { path: card, text: json(it.card) },
    { path: "tests/first-message.json", text: json(first) },
    ...(it.panel ? [{ path: String(it.panel.declared["file"]), text: it.panel.page }] : []),
    ...more,
  ];
}
