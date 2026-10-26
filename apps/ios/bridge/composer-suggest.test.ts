import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { ClientCore } from "@ace/client";
import { ComposeSearch } from "./compose-search.ts";
import { ComposerSuggest, sidebarThreads } from "./composer-suggest.ts";
import {
  commands,
  connect,
  fixture,
  latest,
  open,
  pump,
  reset,
  rows,
  sent,
  until,
} from "./thread-harness.ts";

/*
 * The phone composer's `@`, `/` and + lists over the real SDK and the fake daemon: the rows
 * Swift draws, what picking them leaves in the message, and that typing fast asks the daemon
 * once. No provider CLI runs.
 */

afterEach(reset);

type Row = {
  id: string;
  group: string;
  label: string;
  pick: string;
  action: string | null;
  reference: Record<string, unknown> | null;
};
type List = { seq: number; state: string; rows: Row[] };
const list = () => latest("composer.suggestions") as List | undefined;
const plus = () => latest("composer.add") as List | undefined;
const settled = (seq: number, read = list) =>
  until(() => {
    const shown = read();
    return shown?.seq === seq && shown.state !== "loading" && shown;
  }, `list ${seq}`);

function daemon(provider: "claude" | "codex" = "claude"): FakeDaemon {
  const fake = fixture();
  fake.createThread({ id: "here", workspaceId: "ace", title: "Composer work", provider });
  fake.createThread({ id: "other", workspaceId: "ace", title: "Login fix", provider });
  fake.createThread({ id: "away", workspaceId: "elsewhere", title: "Login elsewhere", provider });
  fake.apply("here", [facts.rootAgent(provider), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}
/** Connected, with the inbox followed as the phone's inbox does. */
async function ready(fake: FakeDaemon): Promise<ClientCore> {
  const client = connect(fake);
  client.threads();
  await until(() => client.connectionState().getSnapshot() === "ready", "the connection");
  return client;
}
function suggest(client: ClientCore, provider: "claude" | "codex" = "claude") {
  return new ComposerSuggest({
    owner: client,
    sink: pump,
    preview: (text) => text,
    schedule: (delay, run) => {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    thread: () => ({ threadId: "here", workspaceId: "ace", provider }),
    threads: () => sidebarThreads(client),
    draft: new ComposeSearch(client, pump, (text) => text),
  });
}
const thread = { type: "thread", threadId: "here" };

test("typing / lists the thread's skills and commands, and + offers only what the phone can run", async () => {
  const client = await ready(daemon());
  const lists = suggest(client);
  lists.handle({ kind: "query", scope: thread, list: "command", query: "", seq: 1 });
  const typed = await settled(1);
  expect(typed.state).toBe("ready");
  expect(typed.rows.some((row) => row.group === "Skills" && row.pick === "reference")).toBe(true);
  expect(typed.rows.some((row) => row.group === "Add")).toBe(false);

  lists.handle({ kind: "query", scope: thread, list: "add", query: "", seq: 2 });
  const adding = await settled(2, plus);
  expect(adding.rows.map((row) => row.label)).toEqual([
    "Attach files",
    "Files and folders",
    "Plan mode",
  ]);
  expect(adding.rows.map((row) => row.action)).toEqual(["attach", "files", "plan"]);
});

test("New thread's + follows the draft rules: a project to choose, no stored files", async () => {
  const client = await ready(daemon("codex"));
  const lists = suggest(client, "codex");
  const draft = { type: "draft", workspaceId: "ace", provider: "codex" };
  lists.handle({ kind: "query", scope: draft, list: "add", query: "", seq: 1 });
  const adding = await settled(1, plus);
  expect(adding.rows.map((row) => row.action)).toEqual(["attach", "files", "project", "goal"]);
});

test("@ lists the project's files and its other threads, and fast typing asks the daemon once", async () => {
  const client = await ready(daemon());
  await until(() => sidebarThreads(client).length === 3, "the inbox");
  const lists = suggest(client);
  for (const [seq, query] of ["R", "RE", "REA"].entries())
    lists.handle({ kind: "query", scope: thread, list: "mention", query, seq });
  const files = await until(() => {
    const shown = list();
    return shown?.seq === 2 && shown.rows.some((row) => row.group === "Files") && shown;
  }, "files");
  expect(files.rows[0]).toMatchObject({
    group: "Files",
    label: "README.md",
    pick: "reference",
    reference: { label: "@README.md", file: { path: "README.md" } },
  });
  const completes = sent.filter((text) => text.includes('"op":"mention.complete"'));
  expect(completes).toHaveLength(1);

  lists.handle({ kind: "query", scope: thread, list: "mention", query: "login", seq: 3 });
  const threads = await until(() => list()?.seq === 3 && list(), "threads");
  expect(threads.rows.filter((row) => row.group === "Threads").map((row) => row.label)).toEqual([
    "Login fix",
  ]);
});

test("a message carries the references still written in it, and a picked skill goes inline", async () => {
  const session = open(connect(daemon()), "here");
  await until(() => latest("thread.controls"), "the composer");
  session.handle({
    type: "send",
    text: "Writing tidy @README.md please",
    opposite: false,
    requestId: "m1",
    references: [
      {
        label: "Writing",
        start: 0,
        end: 7,
        catalog: {
          type: "mention",
          entryId: "claude:skill:writing",
          name: "writing",
          kind: "skill",
          arguments: "",
        },
      },
      { label: "@README.md", start: 13, end: 23, file: { path: "README.md" } },
      // Deleted from the words before sending: it goes nowhere.
      {
        label: "Login fix",
        start: 31,
        end: 40,
        thread: { type: "thread_ref", threadId: "other", budgetBytes: 4096 },
      },
    ],
  });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]).toMatchObject({
    input: [
      { type: "mention", name: "writing" },
      { type: "text", text: " tidy @README.md please" },
    ],
    context: { mentions: [{ path: "README.md" }] },
  });
  expect(commands("thread.send")[0]?.context).not.toHaveProperty("items");
});

test("lists keep answering after a thousand queries", async () => {
  const client = await ready(daemon());
  const lists = suggest(client);
  lists.handle({ kind: "query", scope: thread, list: "command", query: "", seq: 1_234_567 });
  const shown = await settled(1_234_567);
  expect(shown.state).toBe("ready");
});

test("a 65th pick leaves the rest of the message going", async () => {
  const session = open(connect(daemon()), "here");
  await until(() => latest("thread.controls"), "the composer");
  const text = Array.from({ length: 65 }, (_, index) => `@f${index}.ts`).join(" ");
  let at = 0;
  const references = Array.from({ length: 65 }, (_, index) => {
    const label = `@f${index}.ts`;
    const reference = { label, start: at, end: at + label.length, file: { path: `f${index}.ts` } };
    at += label.length + 1;
    return reference;
  });
  session.handle({ type: "send", text, opposite: false, requestId: "many", references });
  await until(() => commands("thread.send").length === 1, "the message");
  const context = commands("thread.send")[0]?.context as { mentions: unknown[] };
  expect(context.mentions).toHaveLength(64);
});

test("/goal sets the goal even while a question waits on the person", async () => {
  const fake = fixture();
  fake.createThread({ id: "here", workspaceId: "ace", title: "Goal work", provider: "codex" });
  fake.apply("here", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "scope",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "scope",
            text: "Which part first?",
            multiSelect: false,
            allowOther: true,
            secret: false,
            options: [{ id: "api", label: "The API" }],
          },
        ],
      },
    },
  ]);
  const session = open(connect(fake), "here");
  const card = await until(
    () => rows("thread.interaction").find((row) => row.kind === "question"),
    "the question",
  );
  session.handle({
    type: "send",
    text: "/goal ship the release",
    opposite: false,
    requestId: "goal",
    reply: { interactionId: String(card.id), picked: {}, written: {}, at: 0 },
  });
  await until(() => commands("thread.goal.set").length === 1, "the goal");
  expect(commands("thread.goal.set")[0]).toMatchObject({
    change: { objective: "ship the release" },
  });
  expect(commands("interaction.resolve")).toHaveLength(0);
});
