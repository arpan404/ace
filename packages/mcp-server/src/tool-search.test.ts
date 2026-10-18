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
    name: "screen_open_app",
    title: "Open native app",
    family: "ace-computer-use",
    description:
      "Launch or rejoin a macOS app by bundle id and take a background session the person can watch.",
    inputSchema: schema({ appId: "The app's bundle id." }),
  },
  {
    name: "screen_ui_act",
    title: "Act on app element",
    family: "ace-computer-use",
    description:
      "Perform an accessibility action on a ref from screen_ui_tree, or press a menu path. Returns a settled UI snapshot.",
    inputSchema: schema({ ref: "An element ref from screen_ui_tree." }),
  },
  {
    name: "screen_input",
    title: "Send app input",
    family: "ace-computer-use",
    description:
      "Click, type, paste, press a key or scroll in the app. Prefer screen_ui_act; points are target-window points. Returns a settled UI snapshot.",
    inputSchema: schema({ action: "click, type, paste, key or scroll." }),
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

it("clicking a button in a named Mac app finds the computer-use tools first", () => {
  const found = names("click button in safari");
  expect(found.slice(0, 2).toSorted()).toEqual(["screen_input", "screen_ui_act"]);
});

it("opening a Mac app by its name finds the tool that opens native apps", () => {
  expect(names("open safari")[0]).toBe("screen_open_app");
  expect(names("launch xcode")[0]).toBe("screen_open_app");
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

it("a word's other forms match it: clicked, clicking and clicks all reach the input tools", () => {
  for (const query of ["clicked in the app", "clicking in the app", "clicks in the app"])
    expect(names(query).slice(0, 2), query).toContain("screen_input");
});

it("a family filter keeps only that family's tools", () => {
  const found = names("click a button", { limit: 5, family: "ace-browser" });
  expect(found).toEqual(["browser_act"]);
});

it("naming a tool outright ranks it first", () => {
  expect(names("machines")[0]).toBe("machines");
  expect(names("browser_open")[0]).toBe("browser_open");
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
