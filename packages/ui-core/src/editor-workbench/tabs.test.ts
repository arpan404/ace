import { describe, expect, it } from "vitest";
import {
  activateTab,
  focusedGroup,
  keepTab,
  limits,
  mruTabs,
  openEditor,
  openEditorToSide,
  pinTab,
  tabLabels,
  unpinTab,
  viewsOf,
} from "./index.ts";
import { group, ids, layoutOf, row, strip, strips } from "./layout.fixture.ts";

const glance = { intent: "glance" } as const;
const keep = { intent: "keep" } as const;

describe("opening files", () => {
  it("a glance opens a preview tab in the focused group", () => {
    const layout = layoutOf(group("g1", []));
    const next = openEditor(layout, "a.ts", glance);
    expect(strip(next, "g1")).toEqual(["~a.ts"]);
    expect(focusedGroup(next).active).toBe("a.ts");
  });

  it("a glance replaces the group's preview tab in its place", () => {
    const layout = layoutOf(group("g1", ["a.ts", "~b.ts", "c.ts"], "a.ts"));
    const next = openEditor(layout, "d.ts", glance);
    expect(strip(next, "g1")).toEqual(["a.ts", "~d.ts", "c.ts"]);
    expect(focusedGroup(next).active).toBe("d.ts");
    expect(focusedGroup(next).mru).not.toContain("b.ts");
  });

  it.each([
    ["glances in a row", [], ["x.ts", "y.ts", "z.ts"], ["~z.ts"]],
    ["a glance after a kept file", ["k.ts"], ["x.ts"], ["k.ts", "~x.ts"]],
    ["a glance while the preview is not showing", ["~p.ts", "k.ts"], ["x.ts"], ["~x.ts", "k.ts"]],
  ])("a group holds at most one preview tab: %s", (_name, start, glances, expected) => {
    let layout = layoutOf(group("g1", start, start.at(-1)?.replace("~", "")));
    for (const path of glances) layout = openEditor(layout, path, glance);
    expect(strip(layout, "g1")).toEqual(expected);
  });

  it("a deliberate open keeps its tab, and the next glance adds beside it", () => {
    let layout = layoutOf(group("g1", []));
    layout = openEditor(layout, "a.ts", keep);
    layout = openEditor(layout, "b.ts", glance);
    expect(strip(layout, "g1")).toEqual(["a.ts", "~b.ts"]);
  });

  it("opening the preview deliberately keeps it", () => {
    const layout = layoutOf(group("g1", ["~a.ts"]));
    expect(strip(openEditor(layout, "a.ts", keep), "g1")).toEqual(["a.ts"]);
  });

  it("double-clicking or typing in a preview keeps it", () => {
    const layout = layoutOf(group("g1", ["~a.ts"]));
    expect(strip(keepTab(layout, { group: "g1", path: "a.ts" }), "g1")).toEqual(["a.ts"]);
  });

  it("a preview with unsaved edits stays when the next glance comes", () => {
    const layout = layoutOf(group("g1", ["~a.ts"]));
    const next = openEditor(layout, "b.ts", { ...glance, unsaved: new Set(["a.ts"]) });
    expect(strip(next, "g1")).toEqual(["a.ts", "~b.ts"]);
  });

  it("a file already open in the focused group comes forward instead of opening twice", () => {
    const layout = layoutOf(group("g1", ["a.ts", "b.ts"], "b.ts"));
    const next = openEditor(layout, "a.ts", glance);
    expect(strip(next, "g1")).toEqual(["a.ts", "b.ts"]);
    expect(focusedGroup(next).active).toBe("a.ts");
  });

  it("a file open only in another group opens a second view in the focused group", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g2");
    const next = openEditor(layout, "a.ts", keep);
    expect(strips(next)).toEqual({ g1: ["a.ts"], g2: ["b.ts", "a.ts"] });
    expect(viewsOf(next, "a.ts")).toEqual([
      { group: "g1", path: "a.ts" },
      { group: "g2", path: "a.ts" },
    ]);
  });

  it("a new tab opens after the active tab, never among the pinned ones", () => {
    const after = layoutOf(group("g1", ["a.ts", "b.ts", "c.ts"], "a.ts"));
    expect(strip(openEditor(after, "n.ts", keep), "g1")).toEqual(["a.ts", "n.ts", "b.ts", "c.ts"]);
    const pinned = layoutOf(group("g1", ["^p.ts", "^q.ts", "a.ts"], "p.ts"));
    expect(strip(openEditor(pinned, "n.ts", keep), "g1")).toEqual([
      "^p.ts",
      "^q.ts",
      "n.ts",
      "a.ts",
    ]);
  });

  it("an open into a named group focuses that group", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", [])]), "g1");
    const next = openEditor(layout, "b.ts", { ...keep, group: "g2" });
    expect(next.focused).toBe("g2");
    expect(strip(next, "g2")).toEqual(["b.ts"]);
  });

  it("⌘-click opens in the group to the right", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g1");
    const next = openEditorToSide(layout, "c.ts", keep, ids());
    expect(strips(next)).toEqual({ g1: ["a.ts"], g2: ["b.ts", "c.ts"] });
    expect(next.focused).toBe("g2");
  });

  it("⌘-click splits right when there is no group to the right", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g2");
    const next = openEditorToSide(layout, "c.ts", glance, ids());
    expect(strips(next)).toEqual({ g1: ["a.ts"], g2: ["b.ts"], n1: ["~c.ts"] });
    expect(next.focused).toBe("n1");
  });

  it("⌘-click with the most groups there can be opens in the focused group", () => {
    const groups = Array.from({ length: limits.groups }, (_, i) => group(`g${i + 1}`, ["a.ts"]));
    const layout = layoutOf(row(groups), `g${limits.groups}`);
    const next = openEditorToSide(layout, "c.ts", keep, ids());
    expect(strip(next, `g${limits.groups}`)).toEqual(["a.ts", "c.ts"]);
  });
});

describe("pinned tabs", () => {
  it("pinning keeps the tab and moves it to the end of the pinned tabs", () => {
    const layout = layoutOf(group("g1", ["^p.ts", "a.ts", "~b.ts"]));
    expect(strip(pinTab(layout, { group: "g1", path: "b.ts" }), "g1")).toEqual([
      "^p.ts",
      "^b.ts",
      "a.ts",
    ]);
  });

  it("unpinning moves the tab to the first place after the pinned tabs", () => {
    const layout = layoutOf(group("g1", ["^p.ts", "^q.ts", "a.ts"]));
    expect(strip(unpinTab(layout, { group: "g1", path: "p.ts" }), "g1")).toEqual([
      "^q.ts",
      "p.ts",
      "a.ts",
    ]);
  });
});

describe("most recently used order", () => {
  it("lists the group's editors from the last shown back", () => {
    let layout = layoutOf(group("g1", ["a.ts", "b.ts", "c.ts"], "a.ts"));
    layout = activateTab(layout, { group: "g1", path: "c.ts" });
    layout = activateTab(layout, { group: "g1", path: "b.ts" });
    expect(mruTabs(focusedGroup(layout)).map((tab) => tab.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  it("showing a tab in another group focuses that group", () => {
    const layout = layoutOf(row([group("g1", ["a.ts"]), group("g2", ["b.ts"])]), "g1");
    expect(activateTab(layout, { group: "g2", path: "b.ts" }).focused).toBe("g2");
  });

  it("showing a tab that isn't open changes nothing", () => {
    const layout = layoutOf(group("g1", ["a.ts"]));
    expect(activateTab(layout, { group: "g1", path: "zzz.ts" })).toBe(layout);
  });
});

describe("tab names", () => {
  it.each([
    [
      ["a/index.ts", "b/index.ts"],
      [
        { name: "index.ts", folder: "a" },
        { name: "index.ts", folder: "b" },
      ],
    ],
    [
      ["web/panels/index.ts", "web/files/index.ts", "web/store.ts"],
      [
        { name: "index.ts", folder: "panels" },
        { name: "index.ts", folder: "files" },
        { name: "store.ts" },
      ],
    ],
    [
      ["x/lib/a.ts", "y/lib/a.ts"],
      [
        { name: "a.ts", folder: "x" },
        { name: "a.ts", folder: "y" },
      ],
    ],
    [
      ["a.ts", "src/a.ts"],
      [
        { name: "a.ts", folder: undefined },
        { name: "a.ts", folder: "src" },
      ],
    ],
  ])("same names gain their nearest differing folder: %j", (paths, labels) => {
    expect(tabLabels(paths)).toEqual(labels);
  });
});
