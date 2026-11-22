import { expect, test } from "vitest";
import {
  spadeAppRequestGroup,
  spadeAppToolPhrase,
  spadeGroupAppRequests,
  spadeRequestCard,
} from "./index.ts";

const notion = (id: string) => (id === "c1" ? "Notion" : undefined);

test("a connected app's tool reads as what it does, never its raw name", () => {
  const card = spadeRequestCard("c1__list_shared_pages", { limit: 100 }, "Quill", {
    appName: notion,
  });
  expect(card.sentence).toBe("Quill wants to list your shared Notion pages.");
  expect(spadeRequestCard("c1__create_page", {}, "Quill", { appName: notion }).sentence).toBe(
    "Quill wants to create a Notion page.",
  );
  // A call reached through call_tool reads the same.
  expect(
    spadeRequestCard("call_tool", { name: "c1__list_recent_pages", arguments: {} }, "Quill", {
      appName: notion,
    }).sentence,
  ).toBe("Quill wants to list your recent Notion pages.");
});

test("a leading word that repeats the app's name is dropped, and a two-step name stays whole", () => {
  expect(spadeAppToolPhrase("notion-search", "Notion")).toBe("search Notion");
  expect(spadeAppToolPhrase("notion-create-pages", "Notion")).toBe("create Notion pages");
  expect(spadeAppToolPhrase("API-get-user", "Notion")).toBe("get your Notion user");
  expect(spadeAppToolPhrase("get_or_create_page", "Notion")).toBe(
    "use Notion to get or create page",
  );
  expect(spadeAppToolPhrase("add_event", "Calendar")).toBe("add a Calendar event");
});

test("an app's tool whose app isn't known keeps the older title", () => {
  const card = spadeRequestCard("c9__create_event", {}, "Planner", {
    appName: notion,
    title: () => "Calendar create event",
  });
  expect(card.sentence).toBe("Planner wants to use Calendar create event.");
});

test("requests one app made together read as one sentence, the calls listed under it", () => {
  const reads = spadeAppRequestGroup("Quill", "Notion", [
    { tool: "list_shared_pages", arguments: { limit: 100 } },
    { tool: "list_favorite_pages", arguments: {} },
    { tool: "list_recent_pages", arguments: {} },
  ]);
  expect(reads.sentence).toBe("Quill wants to read your Notion pages.");
  expect(reads.lines).toEqual([
    "List your shared Notion pages · Limit 100",
    "List your favorite Notion pages",
    "List your recent Notion pages",
  ]);
  const same = spadeAppRequestGroup("Quill", "Notion", [
    { tool: "create_page", arguments: { title: "Plan" } },
    { tool: "create_page", arguments: { title: "Notes" } },
  ]);
  expect(same.sentence).toBe("Quill wants to create a Notion page, 2 times.");
  const mixed = spadeAppRequestGroup("Quill", "Notion", [
    { tool: "create_page", arguments: {} },
    { tool: "update_block", arguments: {} },
    { tool: "list_pages", arguments: {} },
  ]);
  expect(mixed.sentence).toBe("Quill wants to do 3 things in Notion.");
});

test("three open requests to one app in a row become one group; others stay apart", () => {
  const ask = (callId: string, name: string, state = "open") => ({
    kind: "ask",
    key: callId,
    callId,
    name,
    state,
  });
  const words = { kind: "text", key: "t" };
  const grouped = spadeGroupAppRequests([
    words,
    ask("a", "c1__list_shared_pages"),
    ask("b", "c1__list_favorite_pages"),
    ask("c", "c1__list_recent_pages"),
    ask("d", "c2__send_email"),
    ask("e", "shell"),
  ]);
  expect(grouped.map((entry) => entry.kind)).toEqual(["one", "app-group", "one", "one"]);
  const group = grouped[1];
  expect(group?.kind === "app-group" && group.items.map((item) => item.key)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(group?.index).toBe(1);
  // One open request alone, or requests already answered, aren't grouped.
  const apart = spadeGroupAppRequests([
    ask("a", "c1__create_page"),
    ask("b", "c1__create_page", "allowed"),
  ]);
  expect(apart.map((entry) => entry.kind)).toEqual(["one", "one"]);
});
