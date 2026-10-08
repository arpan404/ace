import { flakyCheckout, workbench, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

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
      permissionMode: "ask",
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
  // The step that asked keeps its place in the work log, marked as waiting for the person.
  expect(
    await within(feed).findByRole("button", {
      name: "Run rm -rf node_modules/.cache/vitest Waiting for your approval",
    }),
  ).toBeTruthy();

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
  expect(await within(card).findByText(/defaults to no: click Allow once/)).toBeTruthy();
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
  const line = await within(feed).findByRole("group", {
    name: "Question: How should the sheet recover after rotate?",
  });
  expect(line.textContent).toContain("is asking");
  expect(within(feed).queryByRole("radio")).toBeNull();

  const card = await within(await stack()).findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  // The line points at the card: "Answer below" puts focus on its first option.
  await userEvent.click(within(line).getByRole("button", { name: "Answer below" }));
  expect(document.activeElement).toBe(
    within(card).getByRole("radio", { name: /Persist the draft/ }),
  );
  // No Stop while the agent asks, and nothing to submit until an option is picked.
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  await userEvent.click(within(card).getByRole("radio", { name: /Persist the draft/ }));
  // The pick turns the composer's send button into Submit.
  await userEvent.click(await screen.findByRole("button", { name: "Submit" }));
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

test("several questions are answered one at a time: Next through them, then Submit sends all", async () => {
  const app = harness();
  app.play(twoQuestions()).runUntilBlocked();
  await app.open("/t/thread-two");
  const region = await stack();
  expect(await within(region).findByText("1 of 2")).toBeTruthy();
  expect(within(region).queryByRole("radio", { name: "An hour" })).toBeNull();

  await userEvent.click(within(region).getByRole("radio", { name: "SQLite" }));
  await userEvent.click(await screen.findByRole("button", { name: "Next" }));
  expect(await within(region).findByText("2 of 2")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^(Next|Submit)$/ })).toBeNull();

  // Back keeps what was picked.
  await userEvent.click(within(region).getByRole("button", { name: "Back" }));
  expect(within(region).getByRole("radio", { name: "SQLite", checked: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));

  await userEvent.click(within(region).getByRole("radio", { name: "A day" }));
  // Enter in the empty message sends the answer, as the button would.
  await userEvent.click(screen.getByRole("combobox", { name: "Message" }));
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
