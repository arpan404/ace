import { replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const threadId = "thread-replay-cursor";

async function open() {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

/** A message sent while the agent works waits in the queue. */
async function queueMessage(text: string) {
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), `${text}{Enter}`);
  await screen.findByRole("list", { name: "Queued messages" });
}

const approve = (app: ReturnType<typeof harness>, id: string, command: string) =>
  act(() =>
    app.daemon.apply(threadId, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: id,
        blocking: true,
        request: {
          kind: "approval",
          title: `Run ${command}?`,
          options: [
            { id: "allow", kind: "allow_once", label: "Allow once" },
            { id: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ]),
  );

test("nothing renders below the composer: the queue sits in the strip above it", async () => {
  await open();
  await queueMessage("Also cover the mobile path");
  const queue = screen.getByRole("region", { name: "Message queue" });
  const composer = document.querySelector("[data-slot=composer]");
  if (!composer) throw new Error("no composer");
  expect(composer.contains(queue)).toBe(false);
  expect(queue.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an approval takes the strip, with the queue behind a queued indicator", async () => {
  const app = await open();
  await queueMessage("Also cover the mobile path");
  approve(app, "approve-1", "rm -rf node_modules/.cache/vitest");
  const card = await screen.findByRole("region", { name: "Waiting for you" });
  expect(screen.queryByRole("region", { name: "Message queue" })).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: "Show 1 queued message" }));
  const queue = await screen.findByRole("region", { name: "Message queue" });
  expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  // The request stays one click away.
  expect(
    within(queue).getByRole("button", { name: "Show 1 request waiting for you" }),
  ).toBeTruthy();
});

test("a new approval reclaims the strip after the person switched to the queue", async () => {
  const app = await open();
  await queueMessage("Also cover the mobile path");
  approve(app, "approve-1", "rm -rf node_modules/.cache/vitest");
  const card = await screen.findByRole("region", { name: "Waiting for you" });
  await userEvent.click(within(card).getByRole("button", { name: "Show 1 queued message" }));
  await screen.findByRole("region", { name: "Message queue" });
  approve(app, "approve-2", "git push --force");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Message queue" })).toBeNull());
  expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
});

const ask = (app: ReturnType<typeof harness>, id: string) =>
  act(() =>
    app.daemon.apply(threadId, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: id,
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "scope",
              text: "Include generated files?",
              options: [],
              allowOther: true,
              multiSelect: false,
            },
          ],
        },
      },
    ]),
  );

test("the message never answers a question: it queues, and the card's Continue answers", async () => {
  const app = await open();
  await queueMessage("Also cover the mobile path");
  ask(app, "ask-1");
  const card = await screen.findByRole("region", { name: "Waiting for you" });
  await userEvent.click(within(card).getByRole("button", { name: "Show 1 queued message" }));
  await screen.findByRole("region", { name: "Message queue" });
  const message = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Then log the cap{Enter}");
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
  expect(app.daemon.isPending(threadId, "ask-1")).toBe(true);
  // Back on the question, its own field and Continue answer it.
  await userEvent.click(screen.getByRole("button", { name: "Show 1 request waiting for you" }));
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  await userEvent.type(
    within(region).getByRole("textbox", { name: /^Something else/ }),
    "No, skip them",
  );
  await userEvent.click(within(region).getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(app.daemon.isPending(threadId, "ask-1")).toBe(false));
  expect(app.daemon.resolution(threadId, "ask-1")).toEqual({
    kind: "question",
    answers: { scope: ["No, skip them"] },
  });
});
