import { workbench } from "@ace/fake-daemon";
import { HistorySession, ThreadId, ThreadView } from "@ace/protocol";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

function app() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.seedServices({
    historyTranscripts: {
      "saved-claude": [
        { role: "user", text: "Check reconnect retries." },
        { role: "assistant", text: "Retries now stop at the configured cap." },
      ],
      "saved-codex": [
        { role: "user", text: "Trace replay order." },
        { role: "assistant", text: "Saved events arrive before live events." },
      ],
    },
    history: [
      HistorySession.parse({
        id: "saved-claude",
        instanceId: "claude-personal",
        provider: "claude",
        nativeId: "native",
        cwd: "/Users/dev/relay",
        title: "Fix the old retry loop",
        lastActivity: Date.now(),
        messageCount: 2,
        countAccuracy: "exact",
        support: { status: "supported" },
        continuation: { status: "supported" },
      }),
      HistorySession.parse({
        id: "saved-codex",
        instanceId: "codex-personal",
        provider: "codex",
        nativeId: "native-codex",
        cwd: "/Users/dev/relay",
        title: "Trace delivery order",
        lastActivity: Date.now() - 1000,
        messageCount: 2,
        countAccuracy: "exact",
        support: { status: "supported" },
        continuation: {
          status: "unsupported",
          reason: "Install Codex to continue. Import to read the history.",
        },
      }),
    ],
  });
  return made;
}

/** Past sessions are found only from Settings, and only once the person asks. */
async function openHistory(made: ReturnType<typeof app>) {
  await made.open("/settings/providers");
  const project = await screen.findByRole("combobox", { name: "Past sessions project" });
  await userEvent.click(project);
  await userEvent.click(await screen.findByRole("option", { name: /^relay$/ }));
  await userEvent.click(screen.getByRole("button", { name: "Find past sessions" }));
  return screen.findByRole("list", { name: "Past sessions in relay" });
}

test("New thread shows no past sessions, even when provider history exists", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByRole("region", { name: "Past sessions" })).toBeNull();
  expect(screen.queryByText(/past sessions/i)).toBeNull();
  expect(screen.queryByText("Fix the old retry loop")).toBeNull();
  expect(screen.queryByRole("button", { name: /^(Import|Continue) / })).toBeNull();
  await made.open("/setup");
  await screen.findByRole("heading", { level: 1, name: "Set up" });
  expect(screen.queryByText(/past sessions|existing conversation/i)).toBeNull();
  expect(made.daemon.pastSessions.lists).toBe(0);
});

test("Settings reads past sessions only when asked and forgets them on leaving", async () => {
  const made = app();
  const page = await made.open("/settings/providers");
  await screen.findByRole("button", { name: "Find past sessions" });
  expect(screen.queryByText("Fix the old retry loop")).toBeNull();
  expect(made.daemon.pastSessions.lists).toBe(0);
  const project = screen.getByRole("combobox", { name: "Past sessions project" });
  await userEvent.click(project);
  await userEvent.click(await screen.findByRole("option", { name: /^relay$/ }));
  await userEvent.click(screen.getByRole("button", { name: "Find past sessions" }));
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
  expect(within(list).getByText("Fix the old retry loop")).toBeTruthy();
  expect(screen.getByText(/Continue does the same so the conversation can be shown/)).toBeTruthy();
  expect(made.daemon.pastSessions.lists).toBe(1);
  // Leaving the page unmounts it.
  page.unmount();
  await waitFor(() => expect(made.daemon.pastSessions.releases).toBe(1));
  await made.open("/settings/providers");
  await screen.findByRole("button", { name: "Find past sessions" });
  expect(screen.queryByText("Fix the old retry loop")).toBeNull();
});

test("Import opens the saved conversation and the session is not offered again", async () => {
  const made = app();
  const list = await openHistory(made);
  expect(within(list).queryByRole("button", { name: "Continue Trace delivery order" })).toBeNull();
  await userEvent.click(
    within(list).getByRole("button", { name: "Import Fix the old retry loop" }),
  );
  await screen.findByRole("heading", { level: 1, name: "Fix the old retry loop" });
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).getByText("Check reconnect retries.")).toBeTruthy();
  expect(await within(feed).findByText("Retries now stop at the configured cap.")).toBeTruthy();
  expect(within(feed).queryByText("Starting")).toBeNull();
  expect(
    ThreadView.parse(
      made.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("past-saved-claude") }),
    ).thread,
  ).toMatchObject({ status: { state: "done" }, settledAt: expect.any(Number) });
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Add regression coverage",
  );
  await userEvent.keyboard("{Enter}");
  expect(await within(feed).findByText("Add regression coverage")).toBeTruthy();
  const again = await openHistory(made);
  expect(within(again).queryByText("Fix the old retry loop")).toBeNull();
  expect(within(again).getByText("Trace delivery order")).toBeTruthy();
});

test("Continue opens a resumed conversation without sending a made-up message", async () => {
  const made = app();
  const list = await openHistory(made);
  const requests: unknown[] = [];
  const stop = made.client.onMessage((message) => {
    if (message.type === "history.continue") requests.push(message);
  });
  await userEvent.click(await within(list).findByRole("button", { name: /^Continue / }));
  await screen.findByRole("heading", { level: 1, name: "Fix the old retry loop" });
  await waitFor(() =>
    expect(requests).toContainEqual(
      expect.objectContaining({ status: "continued", nativeSessionId: "native" }),
    ),
  );
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByText("Continue")).toBeNull();
  stop();
});

test("a project with no past sessions says so after Find instead of showing an empty list", async () => {
  const made = app();
  made.daemon.seedServices({ history: [] });
  await made.open("/settings/providers");
  await userEvent.click(await screen.findByRole("button", { name: "Find past sessions" }));
  expect(
    await screen.findByText(/^No past sessions in .+ that aren't already in ace\.$/),
  ).toBeTruthy();
  expect(screen.queryByRole("list", { name: /^Past sessions in / })).toBeNull();
});

test("old imported Codex notices and new raw-only items take no visible transcript rows", async () => {
  const made = app();
  await openHistory(made);
  await userEvent.click(await screen.findByRole("button", { name: "Import Trace delivery order" }));
  await screen.findByRole("heading", { name: "Trace delivery order" });
  const thread = ThreadView.parse(
    made.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("past-saved-codex") }),
  ).thread;
  if (!thread?.rootAgentId) throw new Error("Missing imported thread");
  const labels = [
    "Native history record: event_msg",
    "Native history record: turn_context",
    "Native history record: message",
    "Native history record: world_state",
    "Native content block: input_image",
    "Native reasoning record",
    "",
  ];
  for (const [index, text] of labels.entries())
    made.daemon.apply(thread.id, [
      {
        type: "item.upsert",
        agent: "root",
        item: `raw-${index}`,
        draft: {
          complete: true,
          type: "notice",
          level: "info",
          text,
          ...(text ? {} : { code: "history.raw-only" }),
          raw: [
            { type: "event_msg", data: { type: "event_msg", payload: { type: "task_started" } } },
          ],
        },
      },
    ]);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Saved events arrive before live events.")).toBeTruthy();
  for (const text of labels.filter(Boolean)) expect(within(feed).queryByText(text)).toBeNull();
});
