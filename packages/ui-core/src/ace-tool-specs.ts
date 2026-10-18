import type { AceToolFamily, InputKind } from "./ace-tool-problems.ts";
import { appName } from "./app-names.ts";
import { keyChord, playwrightChord } from "./key-chord.ts";
import { middleTruncate } from "./step-display.ts";

/*
 * ace's own tools as sentences: one spec per tool name says what it did in each tense ("Pressed
 * ⌘L in Safari", "Pressing ⌘L in Safari", "Press ⌘L in Safari"). Computer use, the browser and
 * devices live here; agent, thread and other ace tools in `ace-tool-specs-ace.ts`. A new tool
 * plugs in with one entry. Pure.
 */

export interface ToolWords {
  past: string;
  running: string;
  awaiting: string;
  /** A URL or name the row shows as code after the words: "Went to `github.com/login`". */
  target?: string | undefined;
}

export interface SpecFacts {
  args: Record<string, unknown>;
  /** The app's name, the site's host or the device's name, when known. */
  subject: string | undefined;
  /** The accessible name of the element the step's `ref` points at, from an earlier read. */
  element: string | undefined;
}

export interface AceToolSpec {
  family: AceToolFamily;
  /** The input a step sends, so a refusal can say what was refused. Merged tools read args. */
  input?: InputKind | ((args: Record<string, unknown>) => InputKind | undefined);
  words(facts: SpecFacts): ToolWords;
}

export type Verbs = readonly [past: string, running: string, awaiting: string];

/** One sentence in three tenses: the verbs, then what and where. */
export function say(verbs: Verbs, rest = "", target?: string): ToolWords {
  return { past: verbs[0] + rest, running: verbs[1] + rest, awaiting: verbs[2] + rest, target };
}

export const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** “gmail.com”: the first line, cut at `max` characters. */
export function quote(text: string, max = 40): string {
  const line = text.split("\n")[0]!.trim();
  return `“${line.length > max ? `${line.slice(0, max - 1)}…` : line}”`;
}

/** "github.com/login" for a URL; the text itself when it isn't one. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return middleTruncate(host + path, 48);
  } catch {
    return middleTruncate(url, 48);
  }
}

/** "github.com" for a URL with a web host. */
export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname
      ? parsed.hostname.replace(/^www\./, "")
      : undefined;
  } catch {
    return undefined;
  }
}

export const verbs = {
  opened: ["Opened", "Opening", "Open"],
  took: ["Took", "Taking", "Take"],
  clicked: ["Clicked", "Clicking", "Click"],
  typed: ["Typed", "Typing", "Type"],
  pasted: ["Pasted", "Pasting", "Paste"],
  pressed: ["Pressed", "Pressing", "Press"],
  scrolled: ["Scrolled", "Scrolling", "Scroll"],
  read: ["Read", "Reading", "Read"],
  lookedFor: ["Looked for", "Looking for", "Look for"],
  measured: ["Measured smoothness", "Measuring smoothness", "Measure smoothness"],
  started: ["Started", "Starting", "Start"],
  stopped: ["Stopped", "Stopping", "Stop"],
  closed: ["Closed", "Closing", "Close"],
  waited: ["Waited for", "Waiting for", "Wait for"],
  listed: ["Listed", "Listing", "List"],
  checked: ["Checked", "Checking", "Check"],
} satisfies Record<string, Verbs>;

const at = (subject: string | undefined, preposition = "in") =>
  subject ? ` ${preposition} ${subject}` : "";
const element = (facts: SpecFacts, fallback: string) =>
  facts.element ? quote(facts.element) : fallback;

/* ---------------------------------------------------------------------------------------- */
/* Computer use                                                                              */

function keyOf(args: Record<string, unknown>): string {
  const modifiers = Array.isArray(args["modifiers"])
    ? args["modifiers"].filter((value): value is string => typeof value === "string")
    : [];
  const key = str(args, "key") ?? num(args, "keyCode");
  return key === undefined ? "a key" : keyChord(key, modifiers);
}

const uiActions: Record<string, Verbs> = {
  press: verbs.clicked,
  focus: ["Focused", "Focusing", "Focus"],
  setValue: ["Set", "Setting", "Set"],
  scroll: verbs.scrolled,
  expand: ["Expanded", "Expanding", "Expand"],
  select: ["Selected", "Selecting", "Select"],
  performSecondaryAction: ["Used", "Using", "Use"],
  selectText: ["Selected text in", "Selecting text in", "Select text in"],
};

function uiAct(facts: SpecFacts, place: string): ToolWords {
  const action = str(facts.args, "action") ?? "press";
  const name = str(facts.args, "name") ?? facts.element;
  const what = name ? quote(name) : "an element";
  const value = facts.args["value"];
  const to = action === "setValue" && typeof value === "string" ? ` to ${quote(value)}` : "";
  return say(uiActions[action] ?? verbs.clicked, ` ${what}${to}${at(facts.subject, place)}`);
}

const screen = (words: AceToolSpec["words"], input?: InputKind): AceToolSpec => ({
  family: "screen",
  words,
  ...(input ? { input } : {}),
});

const screenInputs: Record<string, { input: InputKind; words: AceToolSpec["words"] }> = {
  click: {
    input: "click",
    words: (facts) => {
      const right = facts.args["button"] === "right";
      const clicked: Verbs = right
        ? ["Right-clicked", "Right-clicking", "Right-click"]
        : verbs.clicked;
      if (facts.element) return say(clicked, ` ${quote(facts.element)}${at(facts.subject)}`);
      return say(clicked, facts.subject ? ` in ${facts.subject}` : " on the screen");
    },
  },
  type: {
    input: "type",
    words: ({ args, subject }) => {
      const text = str(args, "text");
      return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${at(subject)}`);
    },
  },
  paste: {
    input: "paste",
    words: ({ args, subject }) => {
      const text = str(args, "text");
      return say(verbs.pasted, ` ${text ? quote(text) : "text"}${at(subject, "into")}`);
    },
  },
  key: {
    input: "key",
    words: ({ args, subject }) => say(verbs.pressed, ` ${keyOf(args)}${at(subject)}`),
  },
  scroll: {
    input: "scroll",
    words: ({ subject }) => say(verbs.scrolled, subject ? ` in ${subject}` : " the screen"),
  },
};
const screenInput = (args: Record<string, unknown>) =>
  screenInputs[str(args, "action") ?? ""] ?? screenInputs["click"]!;

/** The role, name or text a find asks for. */
function wanted(args: Record<string, unknown>): string | undefined {
  return str(args, "name") ?? str(args, "text") ?? str(args, "role");
}

const screenSpecs: Record<string, AceToolSpec> = {
  screen_open_app: screen(({ args, subject }) =>
    args["mode"] === "foreground"
      ? say(["Brought", "Bringing", "Bring"], ` ${subject ?? "the app"} forward`)
      : say(verbs.opened, ` ${subject ?? "an app"}`),
  ),
  screen_windows: screen(({ subject }) =>
    say(verbs.listed, ` ${subject ? `${subject}'s` : "the app's"} windows`),
  ),
  screen_screenshot: screen(({ subject }) => say(verbs.took, ` a screenshot${at(subject, "of")}`)),
  screen_input: {
    family: "screen",
    input: (args) => screenInput(args).input,
    words: (facts) => screenInput(facts.args).words(facts),
  },
  screen_ui_tree: screen(({ args, subject }) => {
    const query = wanted(args);
    if (query) return say(verbs.lookedFor, ` ${quote(query)}${at(subject)}`);
    return say(verbs.read, subject ? ` ${subject}'s window` : " the screen");
  }),
  screen_ui_act: screen((facts) => {
    const menu = Array.isArray(facts.args["menu"])
      ? facts.args["menu"].filter((part): part is string => typeof part === "string")
      : [];
    if (menu.length)
      return say(verbs.clicked, ` ${quote(menu.join(" › "), 60)}${at(facts.subject)}`);
    return uiAct(facts, "in");
  }, "act"),
  screen_measure: screen(({ subject }) => say(verbs.measured, at(subject))),
};

/* ---------------------------------------------------------------------------------------- */
/* Browser                                                                                   */

const browser = (words: AceToolSpec["words"], input?: InputKind): AceToolSpec => ({
  family: "browser",
  words,
  ...(input ? { input } : {}),
});

const historyWords: Record<string, ToolWords> = {
  back: say(["Went back", "Going back", "Go back"]),
  forward: say(["Went forward", "Going forward", "Go forward"]),
  reload: say(["Reloaded", "Reloading", "Reload"], " the page"),
  stop: say(verbs.stopped, " loading the page"),
};

const browserActs: Record<string, { input?: InputKind; words: AceToolSpec["words"] }> = {
  click: {
    input: "click",
    words: (facts) => say(verbs.clicked, ` ${element(facts, "on the page")}`),
  },
  type: {
    input: "type",
    words: (facts) => {
      const text = str(facts.args, "text");
      const into = facts.element ? ` into ${quote(facts.element)}` : "";
      return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${into}`);
    },
  },
  press: {
    input: "key",
    words: ({ args }) => {
      const key = str(args, "key");
      return say(verbs.pressed, ` ${key ? playwrightChord(key) : "a key"}`);
    },
  },
  fill_form: {
    input: "type",
    words: ({ args }) => {
      const count = Array.isArray(args["fields"]) ? args["fields"].length : 0;
      return say(
        ["Filled", "Filling", "Fill"],
        count > 1 ? ` ${count} form fields` : " a form field",
      );
    },
  },
  scroll: { input: "scroll", words: () => say(verbs.scrolled, " the page") },
  hover: {
    words: (facts) =>
      say(["Hovered over", "Hovering over", "Hover over"], ` ${element(facts, "an element")}`),
  },
  drag: {
    words: (facts) => say(["Dragged", "Dragging", "Drag"], ` ${element(facts, "an element")}`),
  },
  select: {
    words: (facts) =>
      say(
        ["Chose", "Choosing", "Choose"],
        ` an option${facts.element ? ` in ${quote(facts.element)}` : ""}`,
      ),
  },
  check: { words: (facts) => say(verbs.checked, ` ${element(facts, "a box")}`) },
  uncheck: {
    words: (facts) => say(["Unchecked", "Unchecking", "Uncheck"], ` ${element(facts, "a box")}`),
  },
  focus: {
    words: (facts) => say(["Focused", "Focusing", "Focus"], ` ${element(facts, "an element")}`),
  },
  upload: { words: () => say(["Uploaded", "Uploading", "Upload"], " a file") },
  dialog: {
    words: ({ args }) =>
      args["accept"] === false
        ? say(["Dismissed", "Dismissing", "Dismiss"], " a dialog")
        : say(["Answered", "Answering", "Answer"], " a dialog"),
  },
};
const browserAct = (args: Record<string, unknown>) =>
  browserActs[str(args, "action") ?? ""] ?? browserActs["click"]!;

const browserSettings: Record<string, (args: Record<string, unknown>) => ToolWords> = {
  resize: (args) => {
    const width = num(args, "width");
    const height = num(args, "height");
    return say(
      ["Resized", "Resizing", "Resize"],
      ` the browser${width && height ? ` to ${width}×${height}` : ""}`,
    );
  },
  emulate: () => say(["Changed", "Changing", "Change"], " the device emulation"),
  record_start: () => say(verbs.started, " recording the browser"),
  record_stop: () => say(verbs.stopped, " recording the browser"),
  extensions: () => say(verbs.listed, " browser extensions"),
  close: () => say(verbs.closed, " the browser"),
};

const browserTabs: Record<string, (args: Record<string, unknown>) => ToolWords> = {
  list: () => say(verbs.listed, " browser tabs"),
  open: (args) => {
    const url = str(args, "url");
    const label = str(args, "label");
    return url
      ? say(verbs.opened, " a tab at", shortUrl(url))
      : say(verbs.opened, label ? ` a tab ${quote(label)}` : " a browser tab");
  },
  select: () => say(["Switched", "Switching", "Switch"], " browser tabs"),
  close: () => say(verbs.closed, " a browser tab"),
};

const browserSpecs: Record<string, AceToolSpec> = {
  browser_open: browser(({ args }) => {
    const url = str(args, "url");
    if (url) return say(verbs.opened, "", shortUrl(url));
    return say(verbs.opened, " the browser");
  }),
  browser_tabs: browser(({ args }) =>
    (browserTabs[str(args, "action") ?? "list"] ?? browserTabs["list"]!)(args),
  ),
  browser_snapshot: browser(() => say(verbs.read, " the page")),
  browser_screenshot: browser(({ args, subject }) =>
    args["format"] === "pdf"
      ? say(["Printed", "Printing", "Print"], ` ${subject ?? "the page"} to PDF`)
      : say(verbs.took, ` a screenshot of ${subject ?? "the page"}`),
  ),
  browser_act: {
    family: "browser",
    input: (args) => browserAct(args).input,
    words: (facts) => browserAct(facts.args).words(facts),
  },
  browser_wait_for: browser((facts) => {
    const url = str(facts.args, "url");
    if (url) return say(verbs.waited, "", shortUrl(url));
    const text = str(facts.args, "text");
    if (text) return say(verbs.waited, ` ${quote(text)}`);
    return say(verbs.waited, ` ${element(facts, "the page")}`);
  }),
  browser_find: browser(({ args }) => {
    const text = str(args, "text");
    if (text)
      return say(
        ["Searched the page for", "Searching the page for", "Search the page for"],
        ` ${quote(text)}`,
      );
    const query = str(args, "name") ?? str(args, "role");
    return say(verbs.lookedFor, ` ${query ? quote(query) : "elements"} on the page`);
  }),
  browser_evaluate: browser(() => say(["Ran", "Running", "Run"], " a script on the page")),
  browser_logs: browser(({ args }) =>
    str(args, "requestId")
      ? say(verbs.read, " a network response")
      : say(
          verbs.read,
          args["kind"] === "network"
            ? " network requests"
            : args["kind"] === "downloads"
              ? " the downloads"
              : " the console",
        ),
  ),
  browser_history: browser(({ args }) => {
    const direction = str(args, "direction");
    return direction
      ? (historyWords[direction] ?? historyWords["reload"]!)
      : say(verbs.checked, " the page history");
  }),
  browser_settings: browser(({ args }) =>
    (browserSettings[str(args, "action") ?? ""] ?? browserSettings["emulate"]!)(args),
  ),
  browser_measure: browser(() => say(verbs.measured)),
};

/* ---------------------------------------------------------------------------------------- */
/* In-app simulators and emulators                                                           */

const device = (words: AceToolSpec["words"], input?: InputKind): AceToolSpec => ({
  family: "device",
  words,
  ...(input ? { input } : {}),
});
const on = (subject: string | undefined) => ` on ${subject ?? "the simulator"}`;
const deviceKeys: Record<string, string> = {
  home: "Home",
  back: "Back",
  rotate: "Rotate",
  enter: "Return",
  power: "Power",
};
const tapped: Verbs = ["Tapped", "Tapping", "Tap"];

const simActs: Record<string, { input?: InputKind; words: AceToolSpec["words"] }> = {
  ui: {
    input: "act",
    words: (facts) => {
      const action = str(facts.args, "uiAction") ?? "press";
      return action === "press"
        ? say(tapped, ` ${element(facts, "an element")}${on(facts.subject)}`)
        : uiAct({ ...facts, args: { ...facts.args, action } }, "on");
    },
  },
  tap: {
    input: "click",
    words: ({ subject }) => say(tapped, subject ? ` ${subject}` : " the simulator"),
  },
  long_press: {
    input: "click",
    words: ({ subject }) => say(["Long-pressed", "Long-pressing", "Long-press"], on(subject)),
  },
  swipe: {
    input: "scroll",
    words: ({ subject }) => say(["Swiped", "Swiping", "Swipe"], on(subject)),
  },
  type: {
    input: "type",
    words: ({ args, subject }) => {
      const text = str(args, "text");
      return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${on(subject)}`);
    },
  },
  key: {
    input: "key",
    words: ({ args, subject }) => {
      const key = str(args, "key");
      return say(verbs.pressed, ` ${key ? (deviceKeys[key] ?? key) : "a button"}${on(subject)}`);
    },
  },
  open_app: {
    words: ({ args, subject }) => {
      const app = str(args, "appId");
      return say(verbs.opened, ` ${app ? appName(app) : "an app"}${on(subject)}`);
    },
  },
  open_url: {
    words: ({ args, subject }) => {
      const url = str(args, "url");
      return say(verbs.opened, ` ${url ? shortUrl(url) : "a link"}${on(subject)}`);
    },
  },
  install: {
    words: ({ args, subject }) => {
      const path = str(args, "path");
      const name = path?.split(/[\\/]/).findLast(Boolean);
      return say(["Installed", "Installing", "Install"], ` ${name ?? "an app"}${on(subject)}`);
    },
  },
  record_start: {
    words: ({ subject }) => say(verbs.started, ` recording ${subject ?? "the simulator"}`),
  },
  record_stop: {
    words: ({ subject }) => say(verbs.stopped, ` recording ${subject ?? "the simulator"}`),
  },
};
const simAct = (args: Record<string, unknown>) =>
  simActs[str(args, "action") ?? ""] ?? simActs["ui"]!;

const deviceSpecs: Record<string, AceToolSpec> = {
  sim_list: device(() => say(verbs.listed, " simulators")),
  sim_start: device(({ subject }) => say(verbs.started, ` ${subject ?? "a simulator"}`)),
  sim_stop: device(({ subject }) => say(verbs.stopped, ` ${subject ?? "a simulator"}`)),
  sim_screenshot: device(({ subject }) =>
    say(verbs.took, ` a screenshot of ${subject ?? "the simulator"}`),
  ),
  sim_ui: device(({ args, subject }) => {
    const query = wanted(args);
    if (query) return say(verbs.lookedFor, ` ${quote(query)}${on(subject)}`);
    return say(verbs.read, subject ? ` ${subject}'s screen` : " the simulator's screen");
  }),
  sim_act: {
    family: "device",
    input: (args) => simAct(args).input,
    words: (facts) => simAct(facts.args).words(facts),
  },
  sim_logs: device(({ subject }) =>
    say(verbs.read, subject ? ` ${subject}'s logs` : " the simulator logs"),
  ),
};

/** Computer use, the browser and in-app simulators, by tool name. */
export const surfaceSpecs: Readonly<Record<string, AceToolSpec>> = {
  ...screenSpecs,
  ...browserSpecs,
  ...deviceSpecs,
};
