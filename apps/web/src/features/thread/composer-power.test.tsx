import { longHistory, replayCursor } from "@ace/fake-daemon";
import { ThreadId, type CatalogEntry } from "@ace/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
async function open() {
  const app = harness({ storage: memoryKeyValue() });
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  return {
    app,
    message: await screen.findByRole("combobox", { name: "Message" }),
    feed: screen.getByRole("feed", { name: "Transcript" }),
  };
}
const catalog: CatalogEntry[] = [
  {
    id: "project:explain",
    kind: "command",
    name: "explain",
    description: "Explain a chosen topic",
    source: { provider: "ace", scope: "project" },
    invocation: {
      type: "prompt",
      commandId: "explain",
      parameters: {
        topic: { type: "string", required: true },
        count: { type: "number", required: false, default: 2 },
      },
    },
  },
];
test("mid-message selections remain inline and are sent as structured references in the same order", async () => {
  const { app, message, feed } = await open();
  await userEvent.type(message, "Please /writing");
  const menu = await screen.findByRole("listbox", { name: "Add and commands" });
  expect(within(menu).getByText("Global")).toBeTruthy();
  await userEvent.keyboard("{Tab}");
  await userEvent.type(message, "then /review");
  await screen.findByRole("listbox", { name: "Add and commands" });
  await userEvent.keyboard("{Enter}");
  expect(message.textContent).toBe("Please Writing then Review ");
  await userEvent.type(message, "this branch{Enter}");
  await waitFor(() => expect(feed.textContent).toContain("Please Writing then Review this branch"));
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  const sent =
    view?.kind === "thread"
      ? Object.values(view.items).find(
          (item) =>
            item.type === "message" &&
            item.role === "user" &&
            item.parts.some((part) => part.type === "mention"),
        )
      : undefined;
  expect(
    sent?.type === "message" &&
      sent.parts.filter((part) => part.type === "mention").map((part) => part.name),
  ).toEqual(["writing", "review"]);
});

test("a command with typed arguments opens a form and sends the chosen values", async () => {
  const { app, message } = await open();
  app.daemon.seedServices({ extensionCatalogs: { opencode: catalog } });
  await userEvent.type(message, "Use /explain");
  await screen.findByRole("listbox", { name: "Add and commands" });
  await userEvent.keyboard("{Enter}");
  const form = await screen.findByRole("dialog", { name: "Explain" });
  await userEvent.type(within(form).getByRole("textbox", { name: "topic" }), "Reconnects");
  await userEvent.click(within(form).getByRole("button", { name: "Add command" }));
  expect(message.textContent).toBe("Use Explain ");
  await userEvent.type(message, "carefully{Enter}");
  const feed = screen.getByRole("feed", { name: "Transcript" });
  await waitFor(() => expect(feed.textContent).toContain("Use Explain carefully"));
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  const references =
    view?.kind === "thread"
      ? Object.values(view.items).flatMap((item) =>
          item.type === "message" ? item.parts.filter((part) => part.type === "mention") : [],
        )
      : [];
  expect(references[0]?.values).toEqual({ topic: "Reconnects", count: 2 });
});

test("an inline reference survives navigation and can be removed with the keyboard", async () => {
  const { app, message } = await open();
  await userEvent.type(message, "Try /writing");
  await screen.findByRole("listbox", { name: "Add and commands" });
  await userEvent.keyboard("{Enter}");
  cleanup();
  await app.open("/t/thread-router");
  const restored = await screen.findByRole("combobox", { name: "Message" });
  expect(restored.textContent).toBe("Try Writing ");
  // Selecting the whole draft and deleting also removes its structured references.
  await userEvent.clear(restored);
  await userEvent.type(restored, "Use plain prose{Enter}");
  const feed = screen.getByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Use plain prose");
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  const sent =
    view?.kind === "thread"
      ? Object.values(view.items).findLast(
          (item) => item.type === "message" && item.role === "user",
        )
      : undefined;
  expect(sent?.type === "message" && sent.parts.some((part) => part.type === "mention")).toBe(
    false,
  );
});

test("the catalog refreshes while its menu is open", async () => {
  const { app, message } = await open();
  await userEvent.type(message, "/");
  const menu = await screen.findByRole("listbox", { name: "Add and commands" });
  expect(within(menu).getByText("Writing")).toBeTruthy();
  act(() => app.daemon.seedServices({ extensionCatalogs: { opencode: catalog } }));
  expect(await within(menu).findByText("Explain")).toBeTruthy();
  expect(within(menu).queryByText("Writing")).toBeNull();
});

test("slash commands remain visible and selectable while their catalog refreshes", async () => {
  const { app, message } = await open();
  await userEvent.type(message, "/writing");
  const menu = await screen.findByRole("listbox", { name: "Add and commands" });
  act(() => app.daemon.seedServices({ extensionCatalogs: {}, catalogLoading: ["opencode"] }));
  await screen.findByText("Refreshing commands…");
  expect(screen.getByRole("listbox", { name: "Add and commands" })).toBe(menu);
  expect(within(menu).getByText("Writing")).toBeTruthy();
  expect(screen.queryByText("Loading suggestions…")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: {}, catalogLoading: [] }));
  await waitFor(() => expect(screen.queryByText("Refreshing commands…")).toBeNull());
  await userEvent.keyboard("{Enter}");
  expect(message.textContent).toBe("Writing ");
});

test("renaming a thread does not reload the open command list", async () => {
  const { app, message } = await open();
  await userEvent.type(message, "/writing");
  const menu = await screen.findByRole("listbox", { name: "Add and commands" });
  app.daemon.refuseRequests("forbidden", "catalog.list");
  await act(() =>
    app.client.command({
      type: "thread.rename",
      threadId: ThreadId.parse("thread-router"),
      title: "Renamed with commands open",
    }),
  );
  await screen.findByRole("heading", { name: "Renamed with commands open", level: 1 });
  expect(screen.getByRole("listbox", { name: "Add and commands" })).toBe(menu);
  await userEvent.keyboard("{Enter}");
  expect(message.textContent).toBe("Writing ");
});

test("Enter chooses a current command when a refresh shrinks the highlighted list", async () => {
  const { app, message } = await open();
  app.daemon.seedServices({
    extensionCatalogs: {
      opencode: [
        ...catalog,
        {
          id: "project:review",
          kind: "command",
          name: "review",
          description: "Review the current changes",
          source: { provider: "ace", scope: "project" },
          invocation: { type: "prompt", commandId: "review" },
        },
      ],
    },
  });
  await userEvent.type(message, "/");
  const menu = await screen.findByRole("listbox", { name: "Add and commands" });
  await within(menu).findByText("Review");
  await userEvent.keyboard("{ArrowUp}");
  expect(within(menu).getByRole("option", { selected: true }).textContent).toContain("Explain");
  act(() => app.daemon.seedServices({ extensionCatalogs: { opencode: catalog } }));
  await waitFor(() => expect(within(menu).queryByText("Review")).toBeNull());
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Explain" })).toBeTruthy();
});

test("@ offers another conversation in the project and sends its thread reference", async () => {
  const { app, message } = await open();
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context?.items);
    return receive(command);
  };
  app.daemon.createThread({
    id: "other-router",
    workspaceId: "docs-site",
    title: "Router notes",
    provider: "opencode",
  });
  await userEvent.type(message, "Compare with @Router");
  const menu = await screen.findByRole("listbox", { name: "Files and threads" });
  await userEvent.click(within(menu).getByRole("option", { name: /Router notes/ }));
  await userEvent.type(message, "before changing this{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("feed", { name: "Transcript" }).textContent).toContain(
      "Compare with Router notes before changing this",
    ),
  );
  expect(sent.at(-1)).toEqual([
    { type: "thread_ref", threadId: "other-router", budgetBytes: 4096 },
  ]);
});

test("Send again replaces an uncertain queued message and allows it to run", async () => {
  const app = harness();
  const player = app.play(replayCursor());
  player.runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Check reconnects{Enter}");
  const target = ThreadId.parse("thread-replay-cursor");
  const original = (await app.client.request({ type: "queue.get", threadId: target })).queue
    .messages[0];
  if (!original) throw new Error("Message did not queue");
  act(() => app.daemon.uncertainQueuedMessage(target, original.id));
  const notice = await screen.findByRole("region", {
    name: "A message may already have reached the agent",
  });
  expect(within(notice).getByText(/may run it twice/)).toBeTruthy();
  await userEvent.click(
    await within(await screen.findByRole("list", { name: "Queued messages" })).findByRole(
      "button",
      { name: "Send again" },
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "A message may already have reached the agent" }),
    ).toBeNull(),
  );
  const replacement = (await app.client.request({ type: "queue.get", threadId: target })).queue
    .messages[0];
  expect(replacement?.id).not.toBe(original.id);
  expect(replacement?.input).toEqual(original.input);
  act(() => player.runUntilBlocked());
  expect(
    await within(screen.getByRole("feed", { name: "Transcript" })).findByText("Check reconnects"),
  ).toBeTruthy();
});

test("removing an attachment releases it and the thread attachment list can be managed", async () => {
  const { app } = await open();
  const target = ThreadId.parse("thread-router");
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["Example"], "notes.txt", { type: "text/plain" }),
  );
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  await userEvent.click(within(chips).getByRole("button", { name: "Remove notes.txt" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
  const files = await app.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: target },
  });
  expect(files.result.kind === "attachments" && files.result.attachments.length).toBe(0);
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "/attachments");
  await screen.findByRole("listbox", { name: "Add and commands" });
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Attachments" })).toBeTruthy();
  expect(await screen.findByText("No attachments in this thread.")).toBeTruthy();
});

test("answering a question with an inline reference clears it before the next message", async () => {
  const { app, message, feed } = await open();
  act(() =>
    app.daemon.apply("thread-router", [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "review-topic",
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "topic",
              text: "What should be reviewed?",
              multiSelect: false,
              allowOther: true,
              options: [],
            },
          ],
        },
      },
    ]),
  );
  await screen.findByRole("group", { name: "What should be reviewed?" });
  await userEvent.type(message, "Use /writing");
  await screen.findByRole("listbox", { name: "Add and commands" });
  await userEvent.keyboard("{Tab}");
  await userEvent.type(message, "first{Enter}");
  await waitFor(() => expect(message.textContent).toBe(""));
  await waitFor(() => expect(feed.textContent).toContain("Use Writing first"));
  await userEvent.type(message, "Now move on");
  expect(message.textContent).toBe("Now move on");
});
