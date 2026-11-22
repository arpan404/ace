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
    effect: "read",
  });
  expect(card.sentence).toBe("Quill wants to list your shared Notion pages.");
  expect(spadeRequestCard("c1__create_page", {}, "Quill", { appName: notion }).sentence).toBe(
    "Quill wants to create a Notion page.",
  );
  // A call reached through call_tool reads the same.
  expect(
    spadeRequestCard("call_tool", { name: "c1__list_recent_pages", arguments: {} }, "Quill", {
      appName: notion,
      effect: "read",
    }).sentence,
  ).toBe("Quill wants to list your recent Notion pages.");
});

test("a leading word that repeats the app's name is dropped, and a two-step name stays whole", () => {
  expect(spadeAppToolPhrase("notion-search", "Notion", "read")).toBe("search Notion");
  expect(spadeAppToolPhrase("notion-create-pages", "Notion")).toBe("create Notion pages");
  expect(spadeAppToolPhrase("API-get-user", "Notion", "read")).toBe("get your Notion user");
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

test("a name never vouches for itself: lookup words only when the gate read it as a read", () => {
  expect(spadeAppToolPhrase("list_shared_pages", "Notion", "read")).toBe(
    "list your shared Notion pages",
  );
  expect(spadeAppToolPhrase("search", "Notion")).toBe("use Notion to search");
  expect(spadeAppToolPhrase("list_and_delete", "Notion")).toBe("use Notion to list and delete");
  const card = spadeRequestCard("c1__list_and_delete", {}, "Quill", { appName: notion });
  expect(card.sentence).not.toMatch(/list your/);
});

test("an app's card is headed by the gate's effect, each call with its target and reason", () => {
  const changes = spadeAppRequestGroup("Quill", "Notion", [
    { tool: "create_page", arguments: { parent: { page_id: "Trips" }, title: "Plan" }, ask: "app" },
    { tool: "create_page", arguments: { title: "Notes" }, ask: "app", reason: "Checked." },
  ]);
  expect(changes.sentence).toBe("Quill wants to make 2 changes in Notion.");
  expect(changes.lines).toEqual([
    { text: "Create a Notion page", subject: "Plan", target: "Trips", reason: undefined },
    { text: "Create a Notion page", subject: undefined, target: "Notes", reason: "Checked." },
  ]);
  // Recipients nested deep in the arguments still show.
  const sends = spadeAppRequestGroup("Quill", "Notion", [
    {
      tool: "notify",
      effect: "send_as_person",
      arguments: {
        message: { body: "hi", to: [{ name: "Ana", email: "ana@x.test" }, "sam@x.test"] },
      },
    },
  ]);
  expect(sends.sentence).toBe("Quill wants to send something in your name with Notion.");
  expect(sends.lines[0]?.target).toBe("ana@x.test, sam@x.test");
  // A list_and_delete the gate couldn't place never reads as a read.
  const unknown = spadeAppRequestGroup("Quill", "Notion", [
    { tool: "list_and_delete", arguments: {} },
    { tool: "list_and_delete", arguments: {} },
  ]);
  expect(unknown.sentence).toBe("Quill wants to use Notion 2 times, in ways it doesn't declare.");
  expect(unknown.lines[0]?.text).toBe("Use Notion to list and delete");
});

const ask = (callId: string, name: string, state = "open") => ({
  kind: "ask",
  key: callId,
  callId,
  name,
  state,
});

test("three open requests to one app in a row become one group; others stay apart", () => {
  const words = { kind: "text", key: "t" };
  const grouped = spadeGroupAppRequests([
    words,
    ask("a", "c1__list_shared_pages"),
    ask("b", "c1__list_favorite_pages"),
    ask("c", "c1__list_recent_pages"),
    ask("d", "c2__send_email"),
    ask("e", "shell"),
  ]);
  expect(grouped.map((entry) => entry.kind)).toEqual(["one", "app-group", "app-group", "one"]);
  const group = grouped[1];
  expect(group?.kind === "app-group" && group.items.map((item) => item.key)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(group?.index).toBe(1);
  // Requests of another gate kind start a card of their own.
  const split = spadeGroupAppRequests([
    { ...ask("a", "c1__create_page"), ask: "app" },
    { ...ask("b", "c1__create_page"), ask: "app" },
    { ...ask("c", "c1__notify"), effect: "send_as_person" },
    { ...ask("d", "c1__email_all"), effect: "send_as_person" },
  ]);
  expect(split.map((entry) => (entry.kind === "app-group" ? entry.items.length : 1))).toEqual([
    2, 2,
  ]);
  // A request already answered isn't on a card; one open request alone is a card of its own.
  const apart = spadeGroupAppRequests([
    ask("a", "c1__create_page"),
    ask("b", "c1__create_page", "allowed"),
  ]);
  expect(apart.map((entry) => entry.kind)).toEqual(["app-group", "one"]);
});

test("a call's summary names every recipient: to, cc, bcc and later ones, nested too", () => {
  const words = spadeAppRequestGroup("Quill", "Gmail", [
    {
      tool: "notify",
      effect: "send_as_person",
      arguments: {
        to: "ana@x.test",
        cc: ["ben@x.test", { name: "Cy", email: "cy@x.test" }],
        bcc: [{ email: "hidden@evil.test" }],
        thread: { reply: { to: "dee@x.test" } },
      },
    },
  ]);
  expect(words.lines[0]?.target).toBe(
    "ana@x.test, ben@x.test, cy@x.test, hidden@evil.test, dee@x.test",
  );
});

/** The sentence for one request of the gate kind `effect` (and `kind`). */
const single = (effect: string | undefined, kind?: string) =>
  spadeAppRequestGroup("Quill", "Notion", [{ tool: "x", arguments: {}, effect, ask: kind }])
    .sentence;

test("one app request alone is its own card, headed by the gate's effect", () => {
  const one = spadeGroupAppRequests([ask("a", "c1__create_page")]);
  expect(one.map((entry) => entry.kind)).toEqual(["app-group"]);
  // Not an app's tool: left to the usual card.
  expect(spadeGroupAppRequests([ask("b", "shell")]).map((entry) => entry.kind)).toEqual(["one"]);
  expect(single(undefined, "app")).toBe("Quill wants to make a change in Notion.");
  expect(single("read")).toBe("Quill wants to read Notion.");
  expect(single("pay")).toBe("Quill wants to spend money with Notion.");
  expect(single("change_access")).toBe("Quill wants to change who has access in Notion.");
  expect(single(undefined)).toBe("Quill wants to use Notion in a way it doesn't declare.");
});

/** The summary target of one send the gate read as one, with `args`. */
const target = (args: unknown) =>
  spadeAppRequestGroup("Quill", "Gmail", [
    { tool: "notify", effect: "send_as_person", arguments: args },
  ]).lines[0]?.target;

test("every nested recipient is named: beside a name, past eight levels, under compound keys", () => {
  // A name beside nested addresses hides none of them.
  expect(
    target({ to: { name: "Team", members: [{ email: "a@x.test" }, { email: "b@x.test" }] } }),
  ).toBe("a@x.test, b@x.test");
  // Deeper than eight levels still counts.
  let deep: unknown = { bcc: "deep@evil.test" };
  for (let at = 0; at < 12; at++) deep = { inner: deep };
  expect(target(deep)).toBe("deep@evil.test");
  // Keys split as the gate splits them: bcc_recipients, ccList, toAddresses, notifyEmails.
  expect(
    target({
      bcc_recipients: ["one@x.test"],
      ccList: ["two@x.test"],
      toAddresses: ["three@x.test"],
      notifyEmails: "four@x.test",
      webhookUrl: "https://hook.evil.test",
    }),
  ).toBe("one@x.test, two@x.test, three@x.test, four@x.test, https://hook.evil.test");
});
