import { facts, flakyCheckout, workbench, type Scenario } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { requestIdentity } from "@ace/ui-core";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

type Request = { id: string; title: string; defaultToNo?: boolean };

/** A Codex thread whose agent opens these approvals at once, and waits on all of them. */
function asking(thread: string, requests: readonly Request[]): Scenario {
  return {
    thread: {
      id: thread,
      workspaceId: "relay",
      title: "Migrate sessions",
      provider: "codex",
      access: "ask",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
          ...requests.map((request) => ({
            type: "interaction.opened" as const,
            agent: "root",
            interaction: request.id,
            blocking: true,
            request: {
              kind: "approval" as const,
              title: request.title,
              options: [
                { id: "allow", kind: "allow_once" as const, label: "Allow once" },
                { id: "deny", kind: "deny" as const, label: "Deny" },
              ],
              ...(request.defaultToNo ? { defaultToNo: true } : {}),
            },
          })),
        ],
      },
      ...requests.map((request) => ({ kind: "await" as const, interaction: request.id })),
    ],
  };
}

const stack = () => screen.findByRole("region", { name: "Waiting for you" });

test("an approval is answered on the card attached to the composer, never inside the transcript", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const card = await within(await stack()).findByRole("article", {
    name: "Run rm -rf node_modules/.cache/vitest?",
  });
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByRole("article", { name: /^Run rm -rf/ })).toBeNull();
  expect(within(feed).getAllByText("Waiting for your approval")).toHaveLength(1);

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull());
  expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
    kind: "approval",
    optionId: "allow",
  });
});

test("several open requests stack as a deck: 1 of 3 on top, moved through with ‹ › and ], the next rising when one is answered", async () => {
  const app = harness();
  app
    .play(
      asking("thread-deck", [
        { id: "drop-cache", title: "Clear the build cache?" },
        { id: "rotate-keys", title: "Rotate the signing keys?" },
        { id: "reindex", title: "Rebuild the search index?" },
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/thread-deck");
  const region = await stack();
  expect(await within(region).findByText("1 of 3")).toBeTruthy();
  expect(within(region).getByRole("article", { name: "Clear the build cache?" })).toBeTruthy();

  await userEvent.click(within(region).getByRole("button", { name: "Next request" }));
  expect(within(region).getByRole("article", { name: "Rotate the signing keys?" })).toBeTruthy();
  expect(within(region).getByText("2 of 3")).toBeTruthy();

  within(region).getByRole("button", { name: "Deny" }).focus();
  await userEvent.keyboard("]");
  expect(within(region).getByText("3 of 3")).toBeTruthy();
  await userEvent.keyboard("[[");
  expect(within(region).getByText("2 of 3")).toBeTruthy();
  await userEvent.keyboard("]");
  expect(within(region).getByText("3 of 3")).toBeTruthy();
  await userEvent.click(within(region).getByRole("button", { name: "Previous request" }));
  const rotate = within(region).getByRole("article", { name: "Rotate the signing keys?" });

  // Answering the one on top brings the next up, and the count follows.
  await userEvent.click(within(rotate).getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(app.daemon.isPending("thread-deck", "rotate-keys")).toBe(false));
  expect(app.daemon.resolution("thread-deck", "rotate-keys")).toEqual({
    kind: "approval",
    optionId: "deny",
  });
  expect(await within(await stack()).findByText("1 of 2")).toBeTruthy();
  expect(app.daemon.isPending("thread-deck", "drop-cache")).toBe(true);
  expect(app.daemon.isPending("thread-deck", "reindex")).toBe(true);
});

test("on the deck, a number key never approves a request that defaults to no, even moved to with ]", async () => {
  const app = harness();
  app
    .play(
      asking("thread-careful", [
        { id: "tidy", title: "Tidy the temp folder?" },
        { id: "truncate", title: "Truncate the audit log?", defaultToNo: true },
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/thread-careful");
  const region = await stack();
  await within(region).findByText("1 of 2");
  within(region).getByRole("button", { name: "Deny" }).focus();
  await userEvent.keyboard("]");
  const card = within(region).getByRole("article", { name: "Truncate the audit log?" });

  within(card).getByRole("button", { name: "Deny" }).focus();
  await userEvent.keyboard("1");
  expect(await within(card).findByText(/Read the request, then click Allow once/)).toBeTruthy();
  expect(app.daemon.isPending("thread-careful", "truncate")).toBe(true);

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-careful", "truncate")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});

test("Escape on the deck puts the caret back in the message", async () => {
  const app = harness();
  app
    .play(asking("thread-escape", [{ id: "prune", title: "Prune old branches?" }]))
    .runUntilBlocked();
  await app.open("/t/thread-escape");
  const region = await stack();
  const deny = within(region).getByRole("button", { name: "Deny" });
  // Once the thread has settled, so opening it doesn't take focus back.
  await screen.findByRole("combobox", { name: "Message" });
  await waitFor(() => {
    deny.focus();
    expect(document.activeElement).toBe(deny);
  });
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
  expect(app.daemon.isPending("thread-escape", "prune")).toBe(true);
});

test("a question is answered on the deck; the transcript keeps one line with the question, then its answer", async () => {
  const app = harness();
  const question = workbench().find((scenario) => scenario.thread.id === "thread-sheet-rotate");
  if (!question) throw new Error("workbench lost the question thread");
  app.play(question).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(
    within(feed).queryByRole("group", {
      name: "Question: How should the sheet recover after rotate?",
    }),
  ).toBeNull();
  expect(within(feed).queryByRole("radio")).toBeNull();
  const card = await within(await stack()).findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  // No Stop while the agent asks, and nothing to submit until an option is picked.
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.click(within(card).getByRole("radio", { name: /Persist the draft/ }));
  // The pick enables the card's Continue.
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(app.daemon.isPending("thread-sheet-rotate", "ask-recovery")).toBe(false),
  );
  expect(app.daemon.resolution("thread-sheet-rotate", "ask-recovery")).toEqual({
    kind: "question",
    answers: { recovery: ["persist"] },
  });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull());

  // The line now reads as the question beside its answer, and opens to the whole question.
  const answered = within(feed).getByRole("group", {
    name: "Question: How should the sheet recover after rotate?",
  });
  await waitFor(() =>
    expect(answered.textContent).toContain("Persist the draft in the view model"),
  );
  expect(answered.textContent).toContain("asked");
  await userEvent.click(
    within(answered).getByRole("button", { name: "Show the question and answer" }),
  );
  expect(within(answered).getByText(/^Answered/)).toBeTruthy();
});

/** A Claude thread whose agent asks two questions at once, and waits for both. */
function twoQuestions(): Scenario {
  return {
    thread: { id: "thread-two", workspaceId: "relay", title: "Pick a store", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "claude", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "store",
            blocking: true,
            request: {
              kind: "question",
              questions: [
                {
                  id: "engine",
                  text: "Which store backs the cache?",
                  multiSelect: false,
                  allowOther: false,
                  options: [
                    { id: "sqlite", label: "SQLite" },
                    { id: "memory", label: "In memory" },
                  ],
                },
                {
                  id: "ttl",
                  text: "How long do entries live?",
                  multiSelect: false,
                  allowOther: false,
                  options: [
                    { id: "hour", label: "An hour" },
                    { id: "day", label: "A day" },
                  ],
                },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "store" },
    ],
  };
}

test("several questions are answered one at a time: Continue through them, then it sends all", async () => {
  const app = harness();
  app.play(twoQuestions()).runUntilBlocked();
  await app.open("/t/thread-two");
  const region = await stack();
  expect(await within(region).findByLabelText("Question 1 of 2")).toBeTruthy();
  expect(within(region).queryByRole("radio", { name: "An hour" })).toBeNull();

  await userEvent.click(within(region).getByRole("radio", { name: "SQLite" }));
  await userEvent.click(within(region).getByRole("button", { name: "Continue" }));
  expect(await within(region).findByLabelText("Question 2 of 2")).toBeTruthy();
  expect(within(region).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(
    true,
  );

  // Going back keeps what was picked.
  await userEvent.click(within(region).getByRole("button", { name: "Previous question" }));
  expect(within(region).getByRole("radio", { name: "SQLite", checked: true })).toBeTruthy();
  await userEvent.click(within(region).getByRole("button", { name: "Next question" }));

  // Enter on the picked option continues, as the button would; on the last it sends.
  await userEvent.click(within(region).getByRole("radio", { name: "A day" }));
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-two", "store")).toEqual({
      kind: "question",
      answers: { engine: ["sqlite"], ttl: ["day"] },
    }),
  );
});

test("Skip on the question card declines it, without a message", async () => {
  const app = harness();
  app.play(twoQuestions()).runUntilBlocked();
  await app.open("/t/thread-two");
  const region = await stack();
  await userEvent.click(await within(region).findByRole("button", { name: "Skip" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-two", "store")).toEqual({
      kind: "question",
      answers: {},
      dismissed: true,
    }),
  );
});

for (const [decision, outcome] of [
  ["Allow once", "Approved by you"],
  ["Deny", "Denied by you"],
] as const) {
  test(`${decision} removes the attached approval and notes the outcome on its command's row`, async () => {
    const app = harness();
    app.play(flakyCheckout()).runThrough("approval-requested");
    await app.open("/t/thread-checkout");
    const region = await stack();
    const feed = screen.getByRole("feed", { name: "Transcript" });
    expect(await within(feed).findAllByText("Waiting for your approval")).toHaveLength(1);
    expect(within(feed).queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(within(feed).queryByRole("button", { name: /^Worked for/ })).toBeNull();
    await userEvent.click(within(region).getByRole("button", { name: decision }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull(),
    );
    const row = await within(feed).findByRole("button", {
      name: new RegExp(`rm -rf node_modules/\\.cache/vitest ${outcome}$`),
    });
    expect(row).toBeTruthy();
    // The outcome is the row's suffix, never a second row of its own.
    expect(within(feed).queryByRole("note")).toBeNull();
    expect(within(feed).queryByText("Waiting for your approval")).toBeNull();
  });
}

test("an approved command keeps its execution output in the finished work log", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  act(() =>
    app.daemon.apply("thread-checkout", [
      facts.output("root", "clear-cache", "Cache cleared.\n"),
      facts.toolDone("root", "clear-cache"),
      { type: "background.ended", task: "watcher", status: "stopped" },
      facts.toolDone("root", "watch"),
      facts.endTurn("root"),
    ]),
  );
  const feed = screen.getByRole("feed", { name: "Transcript" });
  await openWorkLog(feed);
  await userEvent.click(
    await within(feed).findByRole("button", { name: /^Ran rm -rf.* Approved by you$/ }),
  );
  expect((await within(feed).findByLabelText("Output")).textContent).toContain("Cache cleared.");
  expect(within(feed).queryByRole("note")).toBeNull();
});

test("keyboard focus survives submitting a decision, advances to the next request, and returns to the composer after the last", async () => {
  const storage = memoryStorage();
  const saved = Promise.withResolvers<void>();
  let hold = false;
  const app = harness({
    outbox: {
      load: storage.load,
      save: async (value) => {
        if (hold) await saved.promise;
        await storage.save(value);
      },
    },
  });
  app
    .play(
      asking("thread-focus", [
        { id: "first", title: "First decision?" },
        { id: "second", title: "Second decision?" },
      ]),
    )
    .runUntilBlocked();
  await app.open("/t/thread-focus");
  const region = await stack();
  const deny = within(region).getByRole("button", { name: "Deny" });
  deny.focus();
  hold = true;
  try {
    await userEvent.keyboard("{Enter}");
    await within(region).findByText(/sending/);
    expect(region.parentElement?.contains(document.activeElement)).toBe(true);
    hold = false;
    saved.resolve();
    await screen.findByRole("article", { name: "Second decision?" });
    expect((await stack()).parentElement?.contains(document.activeElement)).toBe(true);
    await userEvent.tab();
    // Every decision remains reachable using only the keyboard after the card advances.
    for (
      let index = 0;
      index < 10 && document.activeElement !== screen.getByRole("button", { name: "Deny" });
      index++
    )
      await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deny" }));
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
    expect(app.daemon.resolution("thread-focus", "first")).toEqual({
      kind: "approval",
      optionId: "deny",
    });
    expect(app.daemon.resolution("thread-focus", "second")).toEqual({
      kind: "approval",
      optionId: "deny",
    });
  } finally {
    saved.resolve();
  }
});

test("two decision clicks before rendering send one durable answer", async () => {
  const storage = memoryStorage();
  const saved = Promise.withResolvers<void>();
  let hold = false;
  const app = harness({
    outbox: {
      load: storage.load,
      save: async (value) => {
        if (hold) await saved.promise;
        await storage.save(value);
      },
    },
  });
  app.play(asking("thread-double", [{ id: "once", title: "One decision?" }])).runUntilBlocked();
  await app.open("/t/thread-double");
  const deny = within(await stack()).getByRole("button", { name: "Deny" });
  const commands = new Set<string>();
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (input) => {
    if (input.payload.type === "interaction.resolve") commands.add(input.id);
    return command(input);
  };
  hold = true;
  try {
    act(() => {
      fireEvent.click(deny);
      fireEvent.click(deny);
    });
    await screen.findByText(/sending/);
    hold = false;
    saved.resolve();
    await waitFor(() =>
      expect(app.daemon.resolution("thread-double", "once")).toEqual({
        kind: "approval",
        optionId: "deny",
      }),
    );
    expect(commands.size).toBe(1);
  } finally {
    saved.resolve();
  }
});

test("a refused decision keeps the request and keyboard focus and can be retried", async () => {
  const app = harness();
  app
    .play(asking("thread-retry", [{ id: "retry", title: "Retry this decision?" }]))
    .runUntilBlocked();
  app.daemon.refuseCommands("unavailable", "interaction.resolve");
  await app.open("/t/thread-retry");
  const region = await stack();
  within(region).getByRole("button", { name: "Deny" }).focus();
  await userEvent.keyboard("{Enter}");
  await within(region).findByRole("alert");
  expect(app.daemon.isPending("thread-retry", "retry")).toBe(true);
  expect(region.parentElement?.contains(document.activeElement)).toBe(true);
  app.daemon.restoreRequests();
  await userEvent.keyboard("2");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-retry", "retry")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" })),
  );
});

test("reopening a remembered approval keeps its decision controls reachable by keyboard", async () => {
  const app = harness();
  app
    .play(asking("thread-answer-again", [{ id: "again", title: "Answer this approval again?" }]))
    .runUntilBlocked();
  await app.open("/t/thread-answer-again");
  await stack();
  const lease = app.client.thread("thread-answer-again");
  const request = lease.store.interaction(lease.store.interactionIds()[0] ?? "");
  if (!request) throw new Error("Missing replayed approval");
  act(() =>
    answerStore.remember(
      request.id,
      { kind: "approval", optionId: "deny" },
      requestIdentity(request),
    ),
  );
  lease.release();
  await userEvent.click(await screen.findByRole("button", { name: "Answer again" }));
  expect((await stack()).parentElement?.contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("2");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-answer-again", "again")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
});

test("skipping a question keeps keyboard focus in its sending card and returns it to the composer", async () => {
  const storage = memoryStorage();
  const saved = Promise.withResolvers<void>();
  let hold = false;
  const app = harness({
    outbox: {
      load: storage.load,
      save: async (value) => {
        if (hold) await saved.promise;
        await storage.save(value);
      },
    },
  });
  app.play(twoQuestions()).runUntilBlocked();
  await app.open("/t/thread-two");
  const region = await stack();
  within(region).getByRole("button", { name: "Skip" }).focus();
  hold = true;
  try {
    await userEvent.keyboard("{Enter}");
    await within(region).findByText("Sending…");
    expect(document.activeElement).toBe(within(region).getByRole("article"));
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
    // The deck can be reached again while sending and restores focus when it disappears.
    within(region).getByRole("article").focus();
    hold = false;
    saved.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
    expect(app.daemon.resolution("thread-two", "store")).toEqual({
      kind: "question",
      answers: {},
      dismissed: true,
    });
  } finally {
    saved.resolve();
  }
});

test("reopening a remembered question keeps its new form reachable by keyboard", async () => {
  const app = harness();
  app.play(twoQuestions()).runUntilBlocked();
  await app.open("/t/thread-two");
  await stack();
  const lease = app.client.thread("thread-two");
  const request = lease.store.interaction(lease.store.interactionIds()[0] ?? "");
  if (!request) throw new Error("Missing replayed question");
  act(() =>
    answerStore.remember(
      request.id,
      {
        kind: "question",
        answers: { engine: ["sqlite"], ttl: ["day"] },
      },
      requestIdentity(request),
    ),
  );
  lease.release();
  await userEvent.click(await screen.findByRole("button", { name: "Answer again" }));
  const region = await stack();
  expect(document.activeElement).toBe(within(region).getByRole("article"));
  for (
    let index = 0;
    index < 10 && document.activeElement !== within(region).getByRole("button", { name: "Skip" });
    index++
  )
    await userEvent.tab();
  expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Skip" }));
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
  expect(app.daemon.resolution("thread-two", "store")).toEqual({
    kind: "question",
    answers: {},
    dismissed: true,
  });
});
