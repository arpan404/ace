import { expect, test } from "vitest";
import { SidebarIndex, type SidebarFacts } from "./sidebar-index.ts";

const projectA = "project-a";
const projectB = "project-b";
const chatOne = "chat-one";
const chatTwo = "chat-two";

function facts(id: string, workspace: string, options: Partial<SidebarFacts> = {}): SidebarFacts {
  return {
    id,
    revision: 1,
    workspace,
    deleted: false,
    archived: false,
    chat: false,
    settled: true,
    counted: true,
    activity: 100,
    archivedAt: null,
    ...options,
  };
}
/** A thread in a chat's hidden project (ADR 0099). */
const chat = (id: string, workspace: string, options: Partial<SidebarFacts> = {}) =>
  facts(id, workspace, { chat: true, ...options });
function loaded(...all: SidebarFacts[]): SidebarIndex {
  const index = new SidebarIndex();
  index.load(all);
  return index;
}

test("a project's thread window still carries every chat", () => {
  const index = loaded(
    facts("a-old", projectA, { activity: 100 }),
    facts("a-new", projectA, { activity: 900 }),
    facts("a-live", projectA, { activity: 950, settled: false }),
    facts("b-new", projectB, { activity: 1000 }),
    chat("chat-old", chatTwo, { activity: 200 }),
    chat("chat-new", chatOne, { activity: 800 }),
    chat("chat-live", chatOne, { activity: 990, settled: false }),
  );
  const window = index.window({ project: projectA, withChats: true }, 3);
  expect(window.page).toEqual(["a-new", "chat-new", "chat-old"]);
  expect(window.active).toEqual(["chat-live", "a-live"]);
  expect(window.more).toBe(true);
  expect(window.total).toBe(4);
  // Counts stay over every workspace: picking a project does not scope them.
  expect(window.counts).toEqual([
    { id: chatOne, threads: 2 },
    { id: chatTwo, threads: 1 },
    { id: projectA, threads: 3 },
    { id: projectB, threads: 1 },
  ]);
  const whole = index.window({ project: projectA, withChats: true }, 10);
  expect(whole.page).toEqual(["a-new", "chat-new", "chat-old", "a-old"]);
  expect(whole.more).toBe(false);
  expect(whole.total).toBe(4);
});

test("picking a chat's own project lists each chat once", () => {
  const index = loaded(
    facts("a-new", projectA, { activity: 900 }),
    chat("chat-old", chatTwo, { activity: 200 }),
    chat("chat-new", chatOne, { activity: 800 }),
    chat("chat-live", chatOne, { activity: 990, settled: false }),
  );
  const window = index.window({ project: chatOne, withChats: true }, 10);
  expect(window.page).toEqual(["chat-new", "chat-old"]);
  expect(window.active).toEqual(["chat-live"]);
  expect(window.more).toBe(false);
  expect(window.total).toBe(2);
});

test("no project in scope lists every thread, chats included, as before", () => {
  const index = loaded(
    facts("a-old", projectA, { activity: 100 }),
    facts("a-new", projectA, { activity: 900 }),
    facts("a-live", projectA, { activity: 950, settled: false }),
    facts("b-new", projectB, { activity: 1000 }),
    chat("chat-old", chatTwo, { activity: 200 }),
    chat("chat-new", chatOne, { activity: 800 }),
    chat("chat-live", chatOne, { activity: 990, settled: false }),
  );
  const window = index.window({}, 10);
  expect(window.page).toEqual(["b-new", "a-new", "chat-new", "chat-old", "a-old"]);
  expect(window.active).toEqual(["chat-live", "a-live"]);
  expect(window.more).toBe(false);
  expect(window.total).toBe(5);
});

test("a project's archived window carries archived chats too", () => {
  const index = loaded(
    facts("a-archived", projectA, { archived: true, archivedAt: 500 }),
    facts("a-live", projectA, { settled: false, activity: 950 }),
    facts("b-archived", projectB, { archived: true, archivedAt: 700 }),
    chat("chat-archived", chatOne, { archived: true, archivedAt: 600 }),
  );
  const window = index.window({ project: projectA, archived: true, withChats: true }, 1);
  expect(window.page).toEqual(["chat-archived"]);
  expect(window.active).toEqual([]);
  expect(window.more).toBe(true);
  expect(window.total).toBe(2);
  expect(index.window({ project: projectA, archived: true, withChats: true }, 10).page).toEqual([
    "chat-archived",
    "a-archived",
  ]);
});

test("without the client's chat flag a project's window is strictly its own", () => {
  const index = loaded(
    facts("a-new", projectA, { activity: 900 }),
    facts("a-live", projectA, { activity: 950, settled: false }),
    facts("b-new", projectB, { activity: 1000 }),
    chat("chat-new", chatOne, { activity: 980 }),
    chat("chat-live", chatOne, { activity: 990, settled: false }),
  );
  const window = index.window({ project: projectA }, 10);
  expect(window.page).toEqual(["a-new"]);
  expect(window.active).toEqual(["a-live"]);
  expect(window.total).toBe(1);
  expect(window.more).toBe(false);
});

test("a chat that arrives or leaves updates a project's window once", () => {
  const index = loaded(
    facts("a-new", projectA, { activity: 900 }),
    chat("chat", chatOne, { activity: 800 }),
  );
  index.put(chat("chat-2", chatTwo, { activity: 950 }));
  const withTwo = index.window({ project: projectA, withChats: true }, 10);
  expect(withTwo.page).toEqual(["chat-2", "a-new", "chat"]);
  expect(withTwo.total).toBe(3);
  index.remove("chat-2");
  const withoutTwo = index.window({ project: projectA, withChats: true }, 10);
  expect(withoutTwo.page).toEqual(["a-new", "chat"]);
  expect(withoutTwo.total).toBe(2);
});
