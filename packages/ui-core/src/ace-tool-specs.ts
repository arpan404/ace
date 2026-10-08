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
  /** The input a step sends, so a refusal can say what was refused. */
  input?: InputKind;
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

const screenSpecs: Record<string, AceToolSpec> = {
  screen_open_app: screen(({ subject }) => say(verbs.opened, ` ${subject ?? "an app"}`)),
  screen_request_app: screen(({ subject }) =>
    say(["Asked to use", "Asking to use", "Ask to use"], ` ${subject ?? "an app"}`),
  ),
  screen_request_foreground: screen(({ subject }) =>
    say(["Asked to bring", "Asking to bring", "Ask to bring"], ` ${subject ?? "the app"} forward`),
  ),
  screen_screenshot: screen(({ subject }) => say(verbs.took, ` a screenshot${at(subject, "of")}`)),
  screen_click: screen((facts) => {
    const right = facts.args["button"] === "right";
    const clicked: Verbs = right
      ? ["Right-clicked", "Right-clicking", "Right-click"]
      : verbs.clicked;
    if (facts.element) return say(clicked, ` ${quote(facts.element)}${at(facts.subject)}`);
    return say(clicked, facts.subject ? ` in ${facts.subject}` : " on the screen");
  }, "click"),
  screen_type: screen(({ args, subject }) => {
    const text = str(args, "text");
    return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${at(subject)}`);
  }, "type"),
  screen_paste: screen(({ args, subject }) => {
    const text = str(args, "text");
    return say(verbs.pasted, ` ${text ? quote(text) : "text"}${at(subject, "into")}`);
  }, "paste"),
  screen_key: screen(
    ({ args, subject }) => say(verbs.pressed, ` ${keyOf(args)}${at(subject)}`),
    "key",
  ),
  screen_scroll: screen(
    ({ subject }) => say(verbs.scrolled, subject ? ` in ${subject}` : " the screen"),
    "scroll",
  ),
  screen_ui_tree: screen(({ subject }) =>
    say(verbs.read, subject ? ` ${subject}'s window` : " the screen"),
  ),
  screen_ui_find: screen(({ args, subject }) => {
    const query = typeof args["query"] === "object" && args["query"] ? args["query"] : {};
    const record = query as Record<string, unknown>;
    const wanted = str(record, "name") ?? str(record, "text") ?? str(record, "role");
    return say(verbs.lookedFor, ` ${wanted ? quote(wanted) : "an element"}${at(subject)}`);
  }),
  screen_ui_act: screen((facts) => uiAct(facts, "in"), "act"),
  screen_measure_interaction: screen(({ subject }) => say(verbs.measured, at(subject))),
};

/* ---------------------------------------------------------------------------------------- */
/* Browser                                                                                   */

const browser = (words: AceToolSpec["words"], input?: InputKind): AceToolSpec => ({
  family: "browser",
  words,
  ...(input ? { input } : {}),
});

const tabWords: Record<string, (args: Record<string, unknown>) => ToolWords> = {
  list: () => say(verbs.listed, " the browser tabs"),
  open: (args) => {
    const url = str(args, "url");
    return say(verbs.opened, url ? ` ${shortUrl(url)} in a new tab` : " a new tab");
  },
  switch: () => say(["Switched", "Switching", "Switch"], " tabs"),
  close: () => say(verbs.closed, " a tab"),
};

const historyWords: Record<string, ToolWords> = {
  back: say(["Went back", "Going back", "Go back"]),
  forward: say(["Went forward", "Going forward", "Go forward"]),
  reload: say(["Reloaded", "Reloading", "Reload"], " the page"),
};

const browserSpecs: Record<string, AceToolSpec> = {
  ace_browser_open: browser(({ args }) => {
    const url = str(args, "url");
    return url ? say(verbs.opened, "", shortUrl(url)) : say(verbs.opened, " a browser tab");
  }),
  ace_browser_navigate: browser(({ args }) => {
    const url = str(args, "url");
    return say(["Went to", "Going to", "Go to"], url ? "" : " a page", url && shortUrl(url));
  }),
  ace_browser_close: browser(() => say(verbs.closed, " the browser tab")),
  ace_browser_snapshot: browser(() => say(verbs.read, " the page")),
  ace_browser_screenshot: browser(({ subject }) =>
    say(verbs.took, ` a screenshot of ${subject ?? "the page"}`),
  ),
  ace_browser_click: browser(
    (facts) => say(verbs.clicked, ` ${element(facts, "on the page")}`),
    "click",
  ),
  ace_browser_type: browser((facts) => {
    const text = str(facts.args, "text");
    const into = facts.element ? ` into ${quote(facts.element)}` : "";
    return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${into}`);
  }, "type"),
  ace_browser_press: browser(({ args }) => {
    const key = str(args, "key");
    return say(verbs.pressed, ` ${key ? playwrightChord(key) : "a key"}`);
  }, "key"),
  ace_browser_scroll: browser(() => say(verbs.scrolled, " the page"), "scroll"),
  ace_browser_hover: browser((facts) =>
    say(["Hovered over", "Hovering over", "Hover over"], ` ${element(facts, "an element")}`),
  ),
  ace_browser_drag: browser((facts) =>
    say(["Dragged", "Dragging", "Drag"], ` ${element(facts, "an element")}`),
  ),
  ace_browser_select: browser((facts) =>
    say(
      ["Chose", "Choosing", "Choose"],
      ` an option${facts.element ? ` in ${quote(facts.element)}` : ""}`,
    ),
  ),
  ace_browser_check: browser((facts) => say(verbs.checked, ` ${element(facts, "a box")}`)),
  ace_browser_uncheck: browser((facts) =>
    say(["Unchecked", "Unchecking", "Uncheck"], ` ${element(facts, "a box")}`),
  ),
  ace_browser_focus: browser((facts) =>
    say(["Focused", "Focusing", "Focus"], ` ${element(facts, "an element")}`),
  ),
  ace_browser_tabs: browser(({ args }) =>
    (tabWords[str(args, "operation") ?? "list"] ?? tabWords["list"]!)(args),
  ),
  ace_browser_wait_for: browser((facts) => {
    const url = str(facts.args, "url");
    if (url) return say(verbs.waited, "", shortUrl(url));
    const text = str(facts.args, "text");
    if (text) return say(verbs.waited, ` ${quote(text)}`);
    return say(verbs.waited, ` ${element(facts, "the page")}`);
  }),
  ace_browser_find: browser(({ args }) => {
    const wanted = str(args, "name") ?? str(args, "role");
    return say(verbs.lookedFor, ` ${wanted ? quote(wanted) : "elements"} on the page`);
  }),
  ace_browser_find_text: browser(({ args }) => {
    const text = str(args, "text");
    return say(
      ["Searched the page for", "Searching the page for", "Search the page for"],
      ` ${text ? quote(text) : "text"}`,
    );
  }),
  ace_browser_evaluate: browser(() => say(["Ran", "Running", "Run"], " a script on the page")),
  ace_browser_logs: browser(() => say(verbs.read, " the console")),
  ace_browser_network_body: browser(() => say(verbs.read, " a network response")),
  ace_browser_history: browser(
    ({ args }) => historyWords[str(args, "direction") ?? ""] ?? historyWords["reload"]!,
  ),
  ace_browser_navigation_history: browser(() => say(verbs.checked, " the page history")),
  ace_browser_resize: browser(({ args }) => {
    const width = num(args, "width");
    const height = num(args, "height");
    return say(
      ["Resized", "Resizing", "Resize"],
      ` the browser${width && height ? ` to ${width}×${height}` : ""}`,
    );
  }),
  ace_browser_emulate: browser(() =>
    say(["Changed", "Changing", "Change"], " the device emulation"),
  ),
  ace_browser_upload: browser(() => say(["Uploaded", "Uploading", "Upload"], " a file")),
  ace_browser_dialog: browser(({ args }) =>
    args["accept"] === false
      ? say(["Dismissed", "Dismissing", "Dismiss"], " a dialog")
      : say(["Answered", "Answering", "Answer"], " a dialog"),
  ),
  ace_browser_record_start: browser(() => say(verbs.started, " recording the browser")),
  ace_browser_record_stop: browser(() => say(verbs.stopped, " recording the browser")),
  ace_browser_measure_interaction: browser(() => say(verbs.measured)),
};

/* ---------------------------------------------------------------------------------------- */
/* Devices                                                                                   */

const device = (words: AceToolSpec["words"], input?: InputKind): AceToolSpec => ({
  family: "device",
  words,
  ...(input ? { input } : {}),
});
const on = (subject: string | undefined) => ` on ${subject ?? "the device"}`;
const deviceKeys: Record<string, string> = {
  home: "Home",
  back: "Back",
  rotate: "Rotate",
  enter: "Return",
  power: "Power",
};

const deviceSpecs: Record<string, AceToolSpec> = {
  device_list: device(() => say(verbs.listed, " devices")),
  device_boot: device(({ subject }) =>
    say(["Booted", "Booting", "Boot"], ` ${subject ?? "a device"}`),
  ),
  device_start: device(({ subject }) =>
    say(["Started watching", "Starting to watch", "Start watching"], ` ${subject ?? "a device"}`),
  ),
  device_stop: device(({ subject }) =>
    say(["Stopped watching", "Stopping watching", "Stop watching"], ` ${subject ?? "a device"}`),
  ),
  device_open_app: device(({ args, subject }) => {
    const app = str(args, "appId");
    return say(verbs.opened, ` ${app ? appName(app) : "an app"}${on(subject)}`);
  }),
  device_open_url: device(({ args, subject }) => {
    const url = str(args, "url");
    return say(verbs.opened, ` ${url ? shortUrl(url) : "a link"}${on(subject)}`);
  }),
  device_screenshot: device(({ subject }) =>
    say(verbs.took, ` a screenshot of ${subject ?? "the device"}`),
  ),
  device_ui_tree: device(({ subject }) =>
    say(verbs.read, subject ? ` ${subject}'s screen` : " the device's screen"),
  ),
  device_find: device(({ args, subject }) => {
    const query = typeof args["query"] === "object" && args["query"] ? args["query"] : {};
    const record = query as Record<string, unknown>;
    const wanted = str(record, "name") ?? str(record, "text") ?? str(record, "role");
    return say(verbs.lookedFor, ` ${wanted ? quote(wanted) : "an element"}${on(subject)}`);
  }),
  device_act: device((facts) => {
    const action = str(facts.args, "action") ?? "press";
    return action === "press"
      ? say(["Tapped", "Tapping", "Tap"], ` ${element(facts, "an element")}${on(facts.subject)}`)
      : uiAct(facts, "on");
  }, "act"),
  device_tap: device(
    ({ args, subject }) =>
      num(args, "durationMs")
        ? say(["Long-pressed", "Long-pressing", "Long-press"], on(subject))
        : say(["Tapped", "Tapping", "Tap"], subject ? ` ${subject}` : " the device"),
    "click",
  ),
  device_swipe: device(({ subject }) => say(["Swiped", "Swiping", "Swipe"], on(subject)), "scroll"),
  device_type: device(({ args, subject }) => {
    const text = str(args, "text");
    return say(verbs.typed, `${text ? ` ${quote(text)}` : ""}${on(subject)}`);
  }, "type"),
  device_key: device(({ args, subject }) => {
    const key = str(args, "key");
    return say(verbs.pressed, ` ${key ? (deviceKeys[key] ?? key) : "a button"}${on(subject)}`);
  }, "key"),
  device_logs: device(({ subject }) =>
    say(verbs.read, subject ? ` ${subject}'s logs` : " the device logs"),
  ),
  device_record_start: device(({ subject }) =>
    say(verbs.started, ` recording ${subject ?? "the device"}`),
  ),
  device_record_stop: device(({ subject }) =>
    say(verbs.stopped, ` recording ${subject ?? "the device"}`),
  ),
  device_install: device(({ args, subject }) => {
    const path = str(args, "path");
    const name = path?.split(/[\\/]/).findLast(Boolean);
    return say(["Installed", "Installing", "Install"], ` ${name ?? "an app"}${on(subject)}`);
  }),
};

/** Computer use, the browser and devices, by tool name. */
export const surfaceSpecs: Readonly<Record<string, AceToolSpec>> = {
  ...screenSpecs,
  ...browserSpecs,
  ...deviceSpecs,
};
