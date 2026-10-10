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

/** Saved native sessions remain available in Setup, away from the new-thread composer. */
async function openHistory(made: ReturnType<typeof app>) {
  await made.open("/setup");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const project = await screen.findByRole("combobox", { name: "Past sessions project" });
  await userEvent.click(project);
  await userEvent.click(await screen.findByRole("option", { name: /^relay$/ }));
}

test("Setup lists the selected project's sessions and Import opens their saved conversation", async () => {
  const made = app();
  await openHistory(made);
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
  expect(within(list).queryByText("Unavailable")).toBeNull();
  expect(within(list).queryByRole("button", { name: "Continue Trace delivery order" })).toBeNull();
  await userEvent.click(
    within(list).getAllByRole("button", { name: /^Import / })[0] ??
      (() => {
        throw new Error("Missing Import");
      })(),
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
});

test("Continue opens a resumed conversation without sending a made-up message", async () => {
  const made = app();
  await openHistory(made);
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
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

test("Setup can be reopened from the palette and filters past sessions by project", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), "Setup");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Set up" });
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const selector = await screen.findByRole("combobox", { name: "Past sessions project" });
  await userEvent.click(selector);
  await userEvent.click(await screen.findByRole("option", { name: "relay" }));
  await screen.findByText("Fix the old retry loop");
  await userEvent.click(selector);
  await userEvent.click(await screen.findByRole("option", { name: "docs-site" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Past sessions" })).toBeNull());
  expect(screen.queryByText("Fix the old retry loop")).toBeNull();
});

test("Recent sessions stay capped, unavailable and other-project rows stay out, and the dialog searches older sessions by provider", async () => {
  const made = app();
  const sessions = Array.from({ length: 110 }, (_, index) =>
    HistorySession.parse({
      id: `saved-${index}`,
      instanceId: "personal",
      provider: index === 109 ? "pi" : index % 2 ? "codex" : "opencode",
      nativeId: `native-${index}`,
      cwd: "/Users/dev/relay",
      title: index === 109 ? "Find the missing keyboard shortcut" : `Review retry ${index}`,
      lastActivity: 1000000 - index,
      messageCount: 2,
      countAccuracy: "exact",
      support: { status: "supported" },
    }),
  );
  made.daemon.seedServices({
    history: [
      HistorySession.parse({
        ...sessions[0],
        id: "unreadable",
        title: "Unreadable session",
        lastActivity: 2000000,
        support: { status: "unsupported", reason: "The history can't be read." },
      }),
      HistorySession.parse({
        ...sessions[0],
        id: "other-project",
        title: "Different project",
        cwd: "/tmp/other-project",
      }),
      ...sessions,
    ],
  });
  await openHistory(made);
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByText("Unreadable session")).toBeNull();
  expect(screen.queryByText("Different project")).toBeNull();
  expect(screen.queryByText("Find the missing keyboard shortcut")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show all past sessions" }));
  const dialog = await screen.findByRole("dialog", { name: "Past sessions" });
  expect(await within(dialog).findByRole("list", { name: "OpenCode sessions" })).toBeTruthy();
  expect(within(dialog).getByRole("list", { name: "Codex sessions" })).toBeTruthy();
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Search past sessions" }),
    "keyboard",
  );
  expect(await within(dialog).findByText("Find the missing keyboard shortcut")).toBeTruthy();
  expect(within(dialog).getByRole("list", { name: "Pi sessions" })).toBeTruthy();
  expect(within(dialog).queryByText("Review retry 0")).toBeNull();
});

test("A project with no readable sessions has no past sessions section or entry point", async () => {
  const made = app();
  made.daemon.seedServices({ history: [] });
  await openHistory(made);
  await screen.findByRole("combobox", { name: "Past sessions project" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Past sessions" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Show all past sessions" })).toBeNull();
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

test("the full session list stays usable while more saved conversations are being found", async () => {
  const made = app();
  made.daemon.seedServices({
    historyScan: {
      state: "scanning",
      stats: { files: 64, reads: 64, bytes: 1000, skipped: 0 },
      unsupported: [],
    },
  });
  await openHistory(made);
  await userEvent.click(await screen.findByRole("button", { name: "Show all past sessions" }));
  const dialog = await screen.findByRole("dialog", { name: "Past sessions" });
  expect(await within(dialog).findByText("Looking for saved conversations…")).toBeTruthy();
  expect(within(dialog).getByText("Trace delivery order")).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

test("past sessions keep their rows and show a calm retrying status until recovery finishes", async () => {
  const made = app();
  await openHistory(made);
  await screen.findByRole("button", { name: "Import Trace delivery order" });
  made.daemon.seedServices({
    historyScan: {
      state: "retrying",
      stats: { files: 64, reads: 64, bytes: 1000, skipped: 0 },
      unsupported: [],
    },
  });
  expect(await screen.findByText("Past sessions will be back shortly. Retrying…")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show all past sessions" }));
  const dialog = await screen.findByRole("dialog", { name: "Past sessions" });
  expect(
    await within(dialog).findByText("Past sessions will be back shortly. Retrying…"),
  ).toBeTruthy();
  expect(within(dialog).getByText("Trace delivery order")).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  made.daemon.seedServices({
    historyScan: {
      state: "ready",
      stats: { files: 6000, reads: 6000, bytes: 1000, skipped: 0 },
      unsupported: [],
    },
  });
  await waitFor(() =>
    expect(within(dialog).queryByText("Past sessions will be back shortly. Retrying…")).toBeNull(),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Import Trace delivery order" }),
  );
  await screen.findByRole("heading", { name: "Trace delivery order" });
});

test("an empty inventory stays accessible while scanning and retrying instead of showing failure", async () => {
  const made = app();
  made.daemon.seedServices({
    history: [],
    historyScan: {
      state: "scanning",
      stats: { files: 64, reads: 64, bytes: 1000, skipped: 0 },
      unsupported: [],
    },
  });
  await openHistory(made);
  expect(await screen.findByText("Looking for saved conversations…")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show all past sessions" }));
  const dialog = await screen.findByRole("dialog", { name: "Past sessions" });
  expect(await within(dialog).findByText("Looking for saved conversations…")).toBeTruthy();
  expect(within(dialog).queryByText("No matching sessions.")).toBeNull();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  made.daemon.seedServices({
    historyScan: {
      state: "retrying",
      stats: { files: 64, reads: 64, bytes: 1000, skipped: 0 },
      unsupported: [],
    },
  });
  expect(
    await within(dialog).findByText("Past sessions will be back shortly. Retrying…"),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /^Retry$/ })).toBeNull();
});
