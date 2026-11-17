import type { CorpusSample } from "./corpus.ts";

/*
 * The benign corpus (ADR 0173 §8, Tests): realistic skills, plugins, Suits and recipes written for
 * these tests, none of which carries malware or runs. The false-positive test scans every one and
 * asserts that none is blocked; the detection test counts how many are warned. Each sample only
 * does ordinary, useful work. If a real entry like one of these is ever blocked, a rule is too
 * eager and the test fails. Pure data.
 */

const skillMd = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const suitJson = (id: string, name: string, description: string): string =>
  JSON.stringify({
    format: 1,
    id,
    name,
    description,
    version: "1",
    base: "ace",
    light: {},
    dark: {},
  });

const marketJson = (line: string, keywords: string[]): string =>
  JSON.stringify({ line, categories: ["tools"], keywords });

/** A scene that only draws: a drifting gradient on a canvas, yielding each frame. */
const drawingScene = `export function scene(ctx, { width, height, t }) {
  const shade = 0.5 + 0.5 * Math.sin(t / 2000);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, \`rgba(40, 60, 90, \${shade})\`);
  sky.addColorStop(1, "rgba(10, 14, 22, 1)");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 24; i++) {
    const x = (i / 24) * width;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x, height * 0.6, 2, 2);
  }
}
`;

const skills: CorpusSample[] = [
  {
    id: "skill-triage-mail",
    type: "spade-skill",
    name: "triage-mail",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "triage-mail",
        "Sorts a mail inbox into what needs a reply today.",
        "Read the newest mail first, then group threads by sender and flag the ones that name a deadline.",
      ),
    },
  },
  {
    id: "skill-weekly-report",
    type: "spade-skill",
    name: "weekly-report",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "weekly-report",
        "Writes a short weekly status from a list of done items.",
        "Collect the week's finished tasks and summarise them in three bullet points per project.",
      ),
      "scripts/summarise.py":
        "import sys, json\n\n\ndef main():\n    items = json.load(sys.stdin)\n    for project, tasks in items.items():\n        print(f'## {project}')\n        for task in tasks[:3]:\n            print(f'- {task}')\n\n\nif __name__ == '__main__':\n    main()\n",
    },
  },
  {
    id: "skill-format-json",
    type: "spade-skill",
    name: "format-json",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "format-json",
        "Pretty-prints a JSON file with two-space indentation.",
        "Load the file, parse it, and write it back with sorted keys and two-space indentation.",
      ),
      "scripts/format.sh":
        '#!/bin/sh\nset -eu\nfile="$1"\npython3 -m json.tool --sort-keys "$file" "$file.tmp"\nmv "$file.tmp" "$file"\n',
    },
  },
  {
    id: "skill-csv-to-table",
    type: "spade-skill",
    name: "csv-to-table",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "csv-to-table",
        "Turns a CSV file into a Markdown table.",
        "Read the header row for column names, then render each row as a Markdown table line.",
      ),
      "scripts/convert.py":
        "import csv, sys\n\nrows = list(csv.reader(sys.stdin))\nif rows:\n    header, *body = rows\n    print('| ' + ' | '.join(header) + ' |')\n    print('|' + '|'.join(['---'] * len(header)) + '|')\n    for row in body:\n        print('| ' + ' | '.join(row) + ' |')\n",
    },
  },
  {
    id: "skill-git-cleanup",
    type: "spade-skill",
    name: "git-cleanup",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "git-cleanup",
        "Lists local branches already merged into main so they can be removed.",
        "Ask git which branches are merged into main and print each one, never deleting on its own.",
      ),
      "scripts/merged.sh":
        "#!/bin/sh\nset -eu\ngit fetch origin main\ngit branch --merged origin/main | grep -v '\\*' | grep -v 'main$' || true\n",
    },
  },
  {
    id: "skill-spellcheck",
    type: "spade-skill",
    name: "spellcheck-notes",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "spellcheck-notes",
        "Finds likely misspellings in a Markdown note against a word list.",
        "Split the note into words and flag any not found in the dictionary, keeping code spans aside.",
      ),
    },
  },
  {
    id: "skill-release-notes",
    type: "spade-skill",
    name: "release-notes",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "release-notes",
        "Drafts release notes from a range of commit messages.",
        "Group commits by their conventional-commit prefix and write a section for features and fixes.",
      ),
      "scripts/notes.py":
        "import subprocess\n\nlog = subprocess.run(['git', 'log', '--pretty=%s', 'HEAD~20..HEAD'], capture_output=True, text=True)\nfor line in log.stdout.splitlines():\n    kind = line.split(':', 1)[0] if ':' in line else 'other'\n    print(kind, '-', line)\n",
    },
  },
  {
    id: "skill-image-alt",
    type: "spade-skill",
    name: "image-alt-text",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "image-alt-text",
        "Reminds you to add alt text to images in a Markdown document.",
        "Scan the document for image tags and list any whose alt text is empty.",
      ),
    },
  },
  {
    id: "skill-timezone",
    type: "spade-skill",
    name: "timezone-table",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "timezone-table",
        "Shows a meeting time across a list of timezones.",
        "Take a time in one zone and print the matching local time in each of the named zones.",
      ),
      "scripts/zones.py":
        "from datetime import datetime\nfrom zoneinfo import ZoneInfo\n\nzones = ['America/New_York', 'Europe/London', 'Asia/Tokyo']\nnow = datetime.now(ZoneInfo('UTC'))\nfor zone in zones:\n    print(zone, now.astimezone(ZoneInfo(zone)).strftime('%H:%M'))\n",
    },
  },
  {
    id: "skill-todo-extract",
    type: "spade-skill",
    name: "todo-extract",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "todo-extract",
        "Collects TODO comments from a source tree into one list.",
        "Walk the given files and print each line that holds a TODO or FIXME comment with its path.",
      ),
      "scripts/find.sh":
        "#!/bin/sh\nset -eu\ngrep -rn 'TODO\\|FIXME' \"${1:-.}\" --include='*.ts' --include='*.py' || true\n",
    },
  },
  {
    id: "skill-word-count",
    type: "spade-skill",
    name: "word-count",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "word-count",
        "Reports word and reading-time estimates for a document.",
        "Count the words in the document and divide by 200 to estimate reading minutes.",
      ),
    },
  },
  {
    id: "skill-color-contrast",
    type: "spade-skill",
    name: "color-contrast",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "color-contrast",
        "Checks whether two colours meet the WCAG AA contrast ratio.",
        "Compute the relative luminance of each colour and report their contrast ratio.",
      ),
      "scripts/contrast.py":
        "def luminance(rgb):\n    channels = [c / 255 for c in rgb]\n    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]\n    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]\n\n\ndef ratio(a, b):\n    la, lb = luminance(a), luminance(b)\n    hi, lo = max(la, lb), min(la, lb)\n    return (hi + 0.05) / (lo + 0.05)\n",
    },
  },
  {
    id: "skill-sql-explain",
    type: "spade-skill",
    name: "sql-explain",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "sql-explain",
        "Explains what a SELECT statement does in plain words.",
        "Read the query's clauses and describe the tables, joins and filters it uses.",
      ),
    },
  },
  {
    id: "skill-env-template",
    type: "spade-skill",
    name: "env-template",
    category: "benign-skill",
    files: {
      "SKILL.md": skillMd(
        "env-template",
        "Builds a .env.example from the variable names a project reads.",
        "List the environment variable names the code reads and write each as a blank line in the example, never a value.",
      ),
      "scripts/names.sh":
        "#!/bin/sh\nset -eu\ngrep -rho 'process.env.[A-Z_]\\{1,\\}' \"${1:-.}\" | sed 's/process.env.//' | sort -u || true\n",
    },
  },
];

const plugins: CorpusSample[] = [
  {
    id: "plugin-mail-tools",
    type: "spade-plugin",
    name: "mail-tools",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "mail-tools",
        version: "1.0.0",
        description: "Helpers for drafting replies.",
        skills: [{ name: "draft", path: "skills/draft" }],
      }),
      "skills/draft/SKILL.md": skillMd("draft", "Drafts a short reply.", "Write a two-line reply."),
    },
  },
  {
    id: "plugin-calendar",
    type: "spade-plugin",
    name: "calendar-peek",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "calendar-peek",
        version: "0.2.0",
        description: "Shows the next event on your calendar.",
        mcpServers: {
          calendar: { type: "http", url: "https://calendar.example.com/mcp", headers: {} },
        },
      }),
    },
  },
  {
    id: "plugin-linter",
    type: "spade-plugin",
    name: "md-linter",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "md-linter",
        version: "1.3.1",
        description: "Lints Markdown for broken links.",
        hooks: [{ event: "PostToolUse", command: "./bin/lint" }],
      }),
      "bin/lint": "#!/bin/sh\nset -eu\necho 'linting markdown'\nexit 0\n",
    },
  },
  {
    id: "plugin-weather",
    type: "spade-plugin",
    name: "weather",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "weather",
        version: "2.0.0",
        description: "Reads the local forecast.",
        mcpServers: { forecast: { type: "sse", url: "https://wx.example.com/sse", headers: {} } },
      }),
    },
  },
  {
    id: "plugin-notes-search",
    type: "spade-plugin",
    name: "notes-search",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "notes-search",
        version: "0.9.0",
        description: "Searches your local notes folder.",
        mcpServers: {
          notes: { type: "stdio", command: "./bin/notes", args: ["--serve"], env: {} },
        },
      }),
      "bin/notes": "#!/usr/bin/env node\nconsole.log('notes server ready');\n",
    },
  },
  {
    id: "plugin-translate",
    type: "spade-plugin",
    name: "translate",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "translate",
        version: "1.0.0",
        description: "Translates short phrases.",
        mcpServers: {
          translate: { type: "http", url: "https://lingua.example.com/mcp", headers: {} },
        },
      }),
    },
  },
  {
    id: "plugin-standup",
    type: "spade-plugin",
    name: "standup",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "standup",
        version: "1.1.0",
        description: "Collects a daily standup note.",
        skills: [{ name: "ask", path: "skills/ask" }],
      }),
      "skills/ask/SKILL.md": skillMd(
        "ask",
        "Asks the three standup questions.",
        "What did you do, what's next, any blockers?",
      ),
    },
  },
  {
    id: "plugin-pomodoro",
    type: "spade-plugin",
    name: "pomodoro",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "pomodoro",
        version: "0.1.0",
        description: "Runs a focus timer.",
        hooks: [{ event: "SessionStart", command: "./bin/start" }],
      }),
      "bin/start": "#!/bin/sh\necho 'focus session started'\n",
    },
  },
  {
    id: "plugin-bookmarks",
    type: "spade-plugin",
    name: "bookmarks",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "bookmarks",
        version: "1.0.2",
        description: "Saves and lists bookmarks.",
        mcpServers: {
          marks: { type: "stdio", command: "./bin/marks", args: [], env: { MARKS_DIR: "~/marks" } },
        },
      }),
      "bin/marks": "#!/usr/bin/env python3\nprint('bookmarks ready')\n",
    },
  },
  {
    id: "plugin-unit-convert",
    type: "spade-plugin",
    name: "unit-convert",
    category: "benign-plugin",
    files: {
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "unit-convert",
        version: "3.0.0",
        description: "Converts between units.",
        mcpServers: {
          units: { type: "http", url: "https://units.example.com/mcp", headers: {} },
        },
      }),
    },
  },
];

const suits: CorpusSample[] = [
  {
    id: "suit-harbour-dusk",
    type: "suit",
    name: "harbour-dusk",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("harbour-dusk", "Harbour dusk", "Slate panels and a warm lamp."),
      "market.json": marketJson("Slate panels and a warm lamp.", ["slate"]),
    },
  },
  {
    id: "suit-morning-paper",
    type: "suit",
    name: "morning-paper",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("morning-paper", "Morning paper", "Warm off-white with ink text."),
      "suit.css": ":root { --surface: #faf7f0; }",
      "market.json": marketJson("Warm off-white with ink text.", ["paper", "light"]),
    },
  },
  {
    id: "suit-deep-sea",
    type: "suit",
    name: "deep-sea",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("deep-sea", "Deep sea", "Teal depths with a soft current."),
      "scene.js": drawingScene,
      "market.json": marketJson("Teal depths with a soft current.", ["teal", "animated"]),
    },
  },
  {
    id: "suit-forest-floor",
    type: "suit",
    name: "forest-floor",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("forest-floor", "Forest floor", "Moss greens and bark browns."),
      "market.json": marketJson("Moss greens and bark browns.", ["green"]),
    },
  },
  {
    id: "suit-neon-rain",
    type: "suit",
    name: "neon-rain",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("neon-rain", "Neon rain", "City glass in the wet night."),
      "scene.js": drawingScene,
      "market.json": marketJson("City glass in the wet night.", ["neon", "animated"]),
    },
  },
  {
    id: "suit-sandstone",
    type: "suit",
    name: "sandstone",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("sandstone", "Sandstone", "Warm desert light on stone."),
      "market.json": marketJson("Warm desert light on stone.", ["warm"]),
    },
  },
  {
    id: "suit-arctic",
    type: "suit",
    name: "arctic",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("arctic", "Arctic", "Pale blue ice under a low sun."),
      "suit.css": ":root { --accent: #7fb8d8; }",
      "market.json": marketJson("Pale blue ice under a low sun.", ["blue", "cold"]),
    },
  },
  {
    id: "suit-amber-study",
    type: "suit",
    name: "amber-study",
    category: "benign-suit",
    files: {
      "suit.json": suitJson("amber-study", "Amber study", "A reading lamp on dark wood."),
      "market.json": marketJson("A reading lamp on dark wood.", ["dark", "warm"]),
    },
  },
];

const recipes: CorpusSample[] = [
  {
    id: "recipe-inbox",
    type: "spade-bot",
    name: "inbox",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Inbox",
        blurb: "Sorts your mail each morning.",
        task: "You look after the person's inbox and draft replies they can send.",
        model: "fast",
        routines: [
          { name: "Morning sort", instruction: "Sort the inbox.", schedule: "weekdays at 8:00" },
        ],
        needs: {
          connectors: [{ id: "gmail", why: "Reads and drafts mail.", required: true }],
        },
        notes: ["Never send a reply without the person's word."],
      }),
    },
  },
  {
    id: "recipe-standup",
    type: "spade-bot",
    name: "standup-bot",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Standup",
        blurb: "Collects the team's daily standup.",
        task: "Each morning, ask the three standup questions and post a summary to the channel.",
        model: "capable",
        routines: [
          { name: "Ask", instruction: "Ask the standup questions.", schedule: "weekdays at 9:30" },
        ],
        needs: {
          connectors: [{ id: "slack", why: "Posts the daily summary.", required: true }],
        },
        notes: ["Keep each person's answer to three lines."],
      }),
    },
  },
  {
    id: "recipe-calendar",
    type: "spade-bot",
    name: "day-ahead",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Day ahead",
        blurb: "Reads your calendar each morning.",
        task: "Summarise today's meetings and flag any without an agenda.",
        model: "fast",
        needs: {
          connectors: [{ id: "calendar", why: "Reads today's events.", required: true }],
        },
      }),
    },
  },
  {
    id: "recipe-reading",
    type: "spade-bot",
    name: "reading-list",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Reading list",
        blurb: "Keeps a reading list tidy.",
        task: "When the person shares a link, add it to the reading list with a one-line summary.",
        model: "capable",
        skills: ["skills/summarise"],
      }),
      "skills/summarise/SKILL.md": skillMd(
        "summarise",
        "Summarises a page in one line.",
        "Read the page and write a single sentence.",
      ),
    },
  },
  {
    id: "recipe-expenses",
    type: "spade-bot",
    name: "expense-helper",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Expense helper",
        blurb: "Files receipts into a sheet.",
        task: "When the person forwards a receipt, read the amount and date and add a row to the expenses sheet.",
        model: "capable",
        needs: {
          connectors: [
            { id: "sheets", why: "Adds a row per receipt to the expenses sheet.", required: true },
          ],
        },
        notes: ["Ask before filing anything over 500."],
      }),
    },
  },
  {
    id: "recipe-notes",
    type: "spade-bot",
    name: "note-keeper",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Note keeper",
        blurb: "Tidies your notes.",
        task: "Group loose notes by topic and suggest a title for each group.",
        model: "fast",
      }),
    },
  },
  {
    id: "recipe-weather",
    type: "spade-bot",
    name: "weather-brief",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Weather brief",
        blurb: "Tells you what to wear.",
        task: "Each morning, read the forecast and suggest what to wear for the day.",
        model: "fast",
        needs: {
          connectors: [
            { url: "https://wx.example.com/mcp", why: "Reads the local forecast.", required: true },
          ],
        },
      }),
    },
  },
  {
    id: "recipe-release",
    type: "spade-bot",
    name: "release-watch",
    category: "benign-recipe",
    files: {
      "bot.json": JSON.stringify({
        format: "spade-bot",
        version: 2,
        name: "Release watch",
        blurb: "Watches a repo's releases.",
        task: "When a watched repository publishes a release, post its notes to the team channel.",
        model: "capable",
        needs: {
          connectors: [
            { id: "github", why: "Reads release notes.", required: true },
            { id: "slack", why: "Posts the notes.", required: true },
          ],
        },
      }),
    },
  },
];

/** The benign corpus: realistic entries none of which should be blocked. */
export const benignSamples: CorpusSample[] = [...skills, ...plugins, ...suits, ...recipes];
