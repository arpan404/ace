import { expect, test } from "vitest";
import { NativeWorkspace } from "./workspace.ts";
import { RecordingSink } from "./sheet-fixture.ts";

const tools = ["changes", "files", "terminal", "browser", "agents"];
type View = {
  open: boolean;
  active?: string;
  tabs: { title: string }[];
  tools: { label: string }[];
};
const view = (sink: RecordingSink, scope: string) =>
  sink.read(`workspace:${scope}`) as { view: View } | undefined;

/** The machine's database as the app keeps it: read once, written whole on each change. */
function database(initial = "") {
  let kept = initial;
  return {
    kept: () => kept,
    native: { load: async () => kept, save: async (value: string) => void (kept = value) },
  };
}

test("a thread opening gets its panel, and what the person does comes back as the panel to draw", async () => {
  const sink = new RecordingSink();
  const panels = new NativeWorkspace(sink, database().native);
  await panels.handle({ type: "workspace", scope: "t1", tools });
  expect(view(sink, "t1")?.view.open).toBe(false);
  await panels.handle({ type: "workspace", scope: "t1", tools, op: { op: "togglePanel" } });
  await panels.handle({
    type: "workspace",
    scope: "t1",
    tools,
    op: { op: "open", kind: "terminal" },
  });
  const shown = view(sink, "t1")?.view;
  expect(shown?.tabs.map((tab) => tab.title)).toEqual(["Changes", "Files", "Terminal"]);
  expect(shown?.active).toBe("terminal");
});

test("the panel survives a relaunch of the app through the machine's database", async () => {
  const kept = database();
  await new NativeWorkspace(new RecordingSink(), kept.native).handle({
    type: "workspace",
    scope: "t1",
    tools,
    op: { op: "open", kind: "browser" },
  });
  const sink = new RecordingSink();
  await new NativeWorkspace(sink, database(kept.kept()).native).handle({
    type: "workspace",
    scope: "t1",
    tools,
  });
  expect(view(sink, "t1")?.view.tabs.map((tab) => tab.title)).toEqual(["Browser"]);
  expect(view(sink, "t1")?.view.open).toBe(true);
});

test("an op the bridge can't read leaves the panel as it was, and the tools offered follow the app", async () => {
  const sink = new RecordingSink();
  const panels = new NativeWorkspace(sink, database().native);
  await panels.handle({ type: "workspace", scope: "t1", tools, op: { op: "explode" } });
  expect(view(sink, "t1")?.view.tabs).toEqual([]);
  await panels.handle({ type: "workspace", scope: "t1", tools: [...tools, "preview"] });
  expect(view(sink, "t1")?.view.tools.map((tool) => tool.label)).toContain("Run and preview");
});

test("a database that can't be read starts every panel fresh", async () => {
  const sink = new RecordingSink();
  const panels = new NativeWorkspace(sink, {
    load: () => Promise.reject(new Error("locked")),
    save: async () => {},
  });
  await panels.handle({ type: "workspace", scope: "t1", tools, op: { op: "open", kind: "files" } });
  expect(view(sink, "t1")?.view.tabs.map((tab) => tab.title)).toEqual(["Files"]);
});
