import { expect, it } from "vitest";
import { rankTools, type SearchOptions, type SearchableTool } from "./tool-search.ts";

const schema = (fields: Record<string, string> = {}) => ({
  type: "object",
  properties: Object.fromEntries(
    Object.entries(fields).map(([name, description]) => [name, { type: "string", description }]),
  ),
});
const machine = { machine: "Another paired machine's browser (machines); omit for this machine." };

/** A slice of ace's catalogue, in its own words. */
const catalogue: SearchableTool[] = [
  {
    name: "screen_apps",
    title: "List Mac apps",
    family: "ace-computer-use",
    description:
      "List Mac apps: the running ones, plus installed ones matching query. Pass a name or bundle id to screen_state.",
    inputSchema: schema({ query: "Part of a name or bundle id; also searches installed apps." }),
  },
  {
    name: "screen_state",
    title: "Look at a Mac app",
    family: "ace-computer-use",
    description:
      "Open a Mac app in the background, without taking the person's focus, and read its window as an outline: one numbered element per line. Ids stay the same between calls, so later looks return only what changed. Add screenshot:true when you need to see layout or images. Then act with screen_act. For websites use browser_open.",
    inputSchema: schema({
      app: 'App name or bundle id, e.g. "Calculator" or "com.apple.TextEdit".',
      screenshot: "Also return a picture of the window.",
    }),
  },
  {
    name: "screen_act",
    title: "Act in a Mac app",
    family: "ace-computer-use",
    description:
      "Act in an app in the background, then get what changed. Batch steps that need no look in between. Click by element id; use x,y screenshot pixels only for things missing from the outline. Prefer set_value for fields and menu paths for commands.",
    inputSchema: schema({
      app: 'App name or bundle id, e.g. "Calculator" or "com.apple.TextEdit".',
      actions: "click, type, key, set_value, scroll, menu or activate steps.",
    }),
  },
  {
    name: "browser_act",
    title: "Act on page element",
    family: "ace-browser",
    description:
      "Click, type, press a key, hover, select, check, uncheck, drag, focus, upload, scroll or answer a dialog, using refs from browser_snapshot or browser_find.",
    inputSchema: schema({ ref: "An element ref.", ...machine }),
  },
  {
    name: "browser_logs",
    title: "Read console and network",
    family: "ace-browser",
    description: "Read recent console messages and network requests, filtered by kind or level.",
    inputSchema: schema({ kind: "Only console messages or only network requests.", ...machine }),
  },
  {
    name: "browser_open",
    title: "Open browser page",
    family: "ace-browser",
    description: "Open or join this thread's ace browser: a real Chromium page the person watches.",
    inputSchema: schema({ url: "http(s) URL to load.", ...machine }),
  },
  {
    name: "browser_tabs",
    title: "Browser tabs",
    family: "ace-browser",
    description:
      "List, open, select or close tabs in this thread's browser. list shows who opened and drives each tab and whether a person holds it; current marks yours. open gives you a new labelled tab that becomes your current tab.",
    inputSchema: schema({
      action: "list, open, select or close.",
      tabId: "select, close: a tabId from list.",
      ...machine,
    }),
  },
  {
    name: "browser_snapshot",
    title: "Read page structure",
    family: "ace-browser",
    description: "Read the page as compact indented text: one line per meaningful element.",
    inputSchema: schema({
      tabId: "The tab to act in, from browser_tabs or browser_open. Omit for your current tab.",
      ...machine,
    }),
  },
  {
    name: "delegate",
    title: "Delegate to child agents",
    family: "ace-agents",
    description:
      "Start child agents as their own threads, on any installed provider or a paired machine, for independent or parallel work.",
    inputSchema: schema({ task: "What the child should do.", machine: "Run on this machine." }),
  },
  {
    name: "machines",
    title: "List paired machines",
    family: "ace-agents",
    description: "Other machines the person paired that let agents in: name, online or offline.",
    inputSchema: schema(),
  },
  {
    name: "note_add",
    title: "Save a project note",
    family: "ace-threads",
    description: "Remember one short fact about this project for every future thread.",
    inputSchema: schema({ text: "One fact." }),
  },
  {
    name: "context",
    title: "Project context",
    description: "Recent threads, changes, PRs, notes and access for this project.",
    inputSchema: schema({ topics: "Which parts to read." }),
  },
];
const names = (query: string, options: SearchOptions = { limit: 5 }) =>
  rankTools(query, catalogue, options).map((tool) => tool.name);

it("clicking a button in a named Mac app finds the tool that acts in apps first", () => {
  for (const query of ["click button in safari", "click a button in Calculator"])
    expect(names(query)[0], query).toBe("screen_act");
});

it("opening or reading a Mac app by its name finds the tool that looks at native apps", () => {
  for (const query of ["open safari", "open Calculator", "read the Calculator window"])
    expect(names(query)[0], query).toBe("screen_state");
});

it("running a task on another machine finds delegation and the machine list", () => {
  expect(names("run task on other machine").slice(0, 2).toSorted()).toEqual([
    "delegate",
    "machines",
  ]);
});

it("checking a page's console finds the browser's logs first", () => {
  expect(names("check page console")[0]).toBe("browser_logs");
});

it("opening, switching or closing a browser tab finds the tab tool, not every page tool", () => {
  for (const query of ["open a new tab", "switch to another tab", "close the tabs I opened"])
    expect(names(query)[0], query).toBe("browser_tabs");
  // Reading a page is still the page tools' job, even though they take a tabId.
  expect(names("read the page structure")[0]).toBe("browser_snapshot");
});

it("a word's other forms match it: clicked, clicking and clicks all reach the app action tool", () => {
  for (const query of ["clicked in the app", "clicking in the app", "clicks in the app"])
    expect(names(query)[0], query).toBe("screen_act");
});

it("a family filter keeps only that family's tools", () => {
  const found = names("click a button", { limit: 5, family: "ace-browser" });
  expect(found).toEqual(["browser_act"]);
});

it("naming a tool outright ranks it first", () => {
  expect(names("machines")[0]).toBe("machines");
  expect(names("browser_open")[0]).toBe("browser_open");
});

it("naming a tool in any provider's spelling finds exactly what its bare name finds", () => {
  for (const spelled of ["mcp__ace__browser_open", "ace_browser_open", " MCP__ACE__browser_open "])
    expect(names(spelled), spelled).toEqual(names("browser_open"));
  expect(names("browser_open")).toEqual(["browser_open"]);
});

it("a query that shares no meaningful word with any tool finds nothing", () => {
  expect(names("zzz qqq")).toEqual([]);
  expect(names("the and of")).toEqual([]);
});

it("results never exceed the limit and the same query always gives the same order", () => {
  const first = names("open the page", { limit: 2 });
  expect(first.length).toBeLessThanOrEqual(2);
  expect(names("open the page", { limit: 2 })).toEqual(first);
  expect(
    rankTools("open the page", catalogue.toReversed(), { limit: 2 }).map((t) => t.name),
  ).toEqual(first);
});
