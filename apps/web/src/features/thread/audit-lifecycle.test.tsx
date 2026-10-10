import { HistorySession, ThreadId } from "@ace/protocol";
import { longHistory, replayCursor, workbench } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { resetStops } from "./composer/stop-state.ts";
import { enqueueStaged, resetStaged, stage, stagedSends } from "./composer/staged-sends.ts";

beforeEach(() => {
  resetDismissed();
  resetSendStore();
  resetStops();
  resetStaged();
});
afterEach(() => vi.restoreAllMocks());
const field = () => screen.getByRole("combobox", { name: "Message" });
function app(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
async function idle(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  made.play(longHistory(2)).runUntilBlocked();
  await made.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });
  return made;
}

test.each(["ready", "pending", "failed"])(
  "new thread omits past sessions while history reads are %s",
  async (state) => {
    const made = app();
    made.daemon.seedServices({
      history: [
        HistorySession.parse({
          id: "saved-retry",
          instanceId: "claude-personal",
          provider: "claude",
          nativeId: "native-retry",
          cwd: "/Users/dev/relay",
          title: "Fix the old retry loop",
          lastActivity: 1000,
          messageCount: 2,
          countAccuracy: "exact",
          support: { status: "supported" },
        }),
      ],
    });
    if (state === "pending") made.daemon.holdRequests("history.list");
    if (state === "failed") made.daemon.failRequests("history.list");
    await made.open("/new?project=relay");
    await screen.findByRole("combobox", { name: "Message" }, { timeout: 5000 });
    await screen.findByRole("region", { name: "Where this thread runs" }, { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Past sessions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all past sessions" })).toBeNull();
    expect(screen.queryByText("Fix the old retry loop")).toBeNull();
    expect(screen.queryByText("Loading past sessions…")).toBeNull();
    expect(screen.queryByText(/Couldn't load past sessions/)).toBeNull();
  },
  10000,
);

test("catalog failure explains the missing model and Retry recovers it", async () => {
  const made = app();
  made.daemon.failRequests("models.list");
  await made.open("/new?project=relay");
  expect(
    await screen.findByRole("button", { name: "Model: Couldn't load models" }, { timeout: 5000 }),
  ).toBeTruthy();
  made.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Retry loading models" }));
  expect(
    await screen.findByRole("button", { name: /^Model: Opus/ }, { timeout: 5000 }),
  ).toBeTruthy();
});

test("failed provider discovery says it could not check providers", async () => {
  const made = app();
  made.daemon.failRequests("providers.request");
  await made.open("/new?project=relay");
  expect(
    await screen.findByRole(
      "button",
      { name: "Model: Couldn't check providers" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(screen.queryByText("No provider CLI installed")).toBeNull();
}, 10000);

test("failed readiness does not leave installed providers loading forever", async () => {
  const made = app();
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  made.daemon.services.handle = (message, push, device) => {
    if (message.type === "providers.request" && message.operation === "readiness") {
      push({
        type: "providers.result",
        requestId: message.requestId,
        result: { ok: false, error: "unavailable" },
      });
      return true;
    }
    return handle(message, push, device);
  };
  await made.open("/new?project=relay");
  await waitFor(
    () => {
      const model = screen
        .getAllByRole("button")
        .find((button) => button.getAttribute("aria-label")?.startsWith("Model:"));
      expect(model?.getAttribute("aria-label")).not.toBe("Model: loading");
      expect(model?.getAttribute("aria-label")).toMatch(/^Model: (Opus|Sonnet|GPT)/);
    },
    { timeout: 5000 },
  );
}, 10000);

test("a failed create remains reachable as Not sent after leaving its pending route", async () => {
  const made = app();
  made.daemon.refuseCommands("model_unavailable", "thread.create");
  await made.open("/new?project=relay");
  await screen.findByRole("button", { name: /^Model: Opus/ });
  await userEvent.type(field(), "Keep my failed start{Enter}");
  const rows = await screen.findByRole("list", { name: "Starting threads" });
  const row = await within(rows).findByRole("link", { name: /Keep my failed start/ });
  await waitFor(() => expect(row.textContent).toContain("Not sent"));
  await userEvent.click(screen.getByRole("link", { name: "New thread" }));
  expect(await screen.findByRole("heading", { name: "New thread", level: 1 })).toBeTruthy();
  expect(field().textContent).toBe("");
  await userEvent.click(within(rows).getByRole("link", { name: /Keep my failed start/ }));
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
});

test("double-clicking Retry delivers one refused message", async () => {
  const made = await idle();
  made.daemon.refuseCommands("model_unavailable", "thread.send");
  await userEvent.type(field(), "Deliver once{Enter}");
  const retry = await screen.findByRole("button", { name: "Retry" });
  made.daemon.restoreRequests();
  const requests: string[] = [];
  const receive = made.daemon.command.bind(made.daemon);
  made.daemon.command = (command) => {
    if (command.payload.type === "thread.send") requests.push(command.id);
    return receive(command);
  };
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  expect(new Set(requests).size).toBe(1);
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).getAllByText("Deliver once")).toHaveLength(1);
});

test("a failed local save leaves one recoverable copy outside the composer", async () => {
  const storage = memoryStorage();
  let fail = false;
  const made = await idle({
    outbox: {
      load: storage.load,
      save: async (value) => {
        if (fail) throw new Error("storage full");
        await storage.save(value);
      },
    },
  });
  fail = true;
  await userEvent.type(field(), "Retain this once{Enter}");
  await screen.findByRole("button", { name: "Retry" });
  expect(field().textContent).toBe("");
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).getAllByText("Retain this once"),
  ).toHaveLength(1);
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(field().textContent).toBe("Retain this once"));
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).queryByText("Retain this once"),
  ).toBeNull();
  expect(made.client.pendingSends("thread-router").getSnapshot()).toHaveLength(1);
});

test("an enqueue rejection retains a held message and its attachment for another attempt", async () => {
  const made = harness();
  await made.client.start();
  stagedSends(made.storage);
  stage(
    {
      commandId: "held",
      threadId: "thread-router",
      text: "Keep my file",
      mentions: [],
      attachments: [
        { name: "screen.png", mimeType: "image/png", sha256: "a".repeat(64), bytes: 8 },
      ],
    },
    { files: [], previews: [] },
  );
  await made.client.close();
  expect(await enqueueStaged(made.client, "held")).toBe(false);
  expect(stagedSends(made.storage).get()).toEqual([
    expect.objectContaining({
      text: "Keep my file",
      failed: expect.any(String),
      attachments: [expect.objectContaining({ name: "screen.png" })],
    }),
  ]);
});

test("cold slash menu waits for the provider and Enter does not send a loading command", async () => {
  const made = app();
  made.daemon.holdRequests("models.list");
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "/review{Enter}");
  expect(field().textContent).toBe("/review");
  expect(screen.queryByText(/Couldn't load suggestions/)).toBeNull();
  expect(made.client.pendingSends().getSnapshot()).toHaveLength(0);
});

test("reopening a failed slash menu reads its catalog again and failed Enter keeps the draft", async () => {
  const made = await idle();
  made.daemon.failRequests("catalog.list");
  await userEvent.type(field(), "/review");
  await screen.findByText(/Couldn't load suggestions/);
  await userEvent.keyboard("{Enter}");
  expect(field().textContent).toBe("/review");
  await userEvent.keyboard("{Escape}");
  made.daemon.restoreRequests();
  await userEvent.clear(field());
  await userEvent.type(field(), "/");
  expect(await screen.findByRole("listbox", { name: "Add and commands" })).toBeTruthy();
});

test("a transient draft scope refusal retries before showing slash commands", async () => {
  const made = app();
  const original = made.client.request.bind(made.client);
  vi.spyOn(made.client, "request").mockImplementation(async (message, options) => {
    if (message.type === "context.request" && message.operation.op === "draft.create") {
      vi.mocked(made.client.request).mockImplementation(original);
      throw new Error("busy");
    }
    return original(message, options);
  });
  await made.open("/new?project=relay");
  await screen.findByRole("button", { name: /^Model: Opus/ });
  await userEvent.type(field(), "/");
  expect(
    await screen.findByRole("listbox", { name: "Add and commands" }, { timeout: 5000 }),
  ).toBeTruthy();
});

test("the branch fallback uses Current branch while branch discovery is unavailable", async () => {
  const made = app();
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  made.daemon.services.handle = (message, push, device) => {
    if (message.type === "workspace.request" && message.operation.op === "branches.list")
      return true;
    return handle(message, push, device);
  };
  await made.open("/new?project=relay");
  expect(await screen.findByRole("button", { name: "Start from: Current branch" })).toBeTruthy();
});

test("changing the draft project drops the previous project's file references", async () => {
  const made = app();
  await made.open("/new?project=ace");
  await screen.findByRole("button", { name: /^Model: Opus/ });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["Synthetic file"], "old.txt", { type: "text/plain" }),
  );
  expect(await screen.findByText("old.txt")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Project: ace" }));
  await userEvent.click(await screen.findByRole("option", { name: "relay" }));
  expect(await screen.findByRole("button", { name: "Project: relay" })).toBeTruthy();
  expect(screen.queryByText("old.txt")).toBeNull();
  expect(field().textContent).toBe("");
});

test("Safari composition-ending Enter does not send the composer draft", async () => {
  await idle();
  await userEvent.type(field(), "候補");
  fireEvent.keyDown(field(), { key: "Enter", keyCode: 229, isComposing: false });
  expect(field().textContent).toBe("候補");
  expect(within(screen.getByRole("feed", { name: "Transcript" })).queryByText("候補")).toBeNull();
});

test("a provider that keeps working after acknowledging Stop can be stopped again", async () => {
  const made = harness();
  made.play(replayCursor()).runThrough("finding");
  const receive = made.daemon.command.bind(made.daemon);
  made.daemon.command = (command) =>
    command.payload.type === "thread.interrupt"
      ? { ok: true, commandId: command.id }
      : receive(command);
  await made.open("/t/thread-replay-cursor");
  await userEvent.click(await screen.findByRole("button", { name: "Stop the agent" }));
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("a provider without steering does not offer Send now for a queued follow-up", async () => {
  const made = harness();
  const scenario = replayCursor();
  made
    .play({ ...scenario, thread: { ...scenario.thread, capabilities: { steer: false } } })
    .runThrough("finding");
  await made.open("/t/thread-replay-cursor");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Follow up later{Enter}",
  );
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).queryByRole("button", { name: "Send now" })).toBeNull();
  expect(within(queue).getByRole("button", { name: "Take back to composer" })).toBeTruthy();
});

test("Resume sending works before the first queue page has arrived", async () => {
  const made = app();
  made.daemon.holdQueue("thread-dedupe", "not_sent");
  made.daemon.holdRequests("queue.get");
  await made.open("/t/thread-dedupe");
  const resume = await screen.findByRole("button", { name: "Try again" });
  made.daemon.restoreRequests();
  await userEvent.click(resume);
  await waitFor(async () => {
    const reply = await made.client.request({
      type: "queue.get",
      threadId: ThreadId.parse("thread-dedupe"),
    });
    expect(reply.queue.paused).toBe(false);
  });
});

test("empty model discovery stays loading while the provider is refreshing", async () => {
  const made = app();
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  let discovered: (() => void) | undefined;
  const discovery = new Promise<void>((resolve) => {
    discovered = resolve;
  });
  made.daemon.services.handle = (message, push, device) => {
    if (message.type === "models.list") {
      push({
        type: "models.result",
        requestId: message.requestId,
        result: {
          models: [],
          instances: [
            {
              provider: "claude",
              instance: "claude-personal",
              status: "refreshing",
              stale: true,
              refreshing: true,
            },
          ],
        },
      });
      discovered?.();
      return true;
    }
    return handle(message, push, device);
  };
  await made.open("/new?project=relay");
  await discovery;
  // Finish the response's React work before checking the empty, refreshing catalog.
  await act(async () => {});
  expect(await screen.findByRole("button", { name: "Model: loading" })).toBeTruthy();
  expect(screen.queryByText("No provider CLI installed")).toBeNull();
  expect(screen.queryByText("No models available")).toBeNull();
});

test("Retry after a local save failure still retains only one recoverable message", async () => {
  const storage = memoryStorage();
  let fail = false;
  const made = await idle({
    outbox: {
      load: storage.load,
      save: async (value) => {
        if (fail) throw new Error("storage full");
        await storage.save(value);
      },
    },
  });
  fail = true;
  await userEvent.type(field(), "Keep the retry once{Enter}");
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText("Couldn't send it again");
  await waitFor(() =>
    expect(
      within(screen.getByRole("feed", { name: "Transcript" })).getAllByText("Keep the retry once"),
    ).toHaveLength(1),
  );
  expect(field().textContent).toBe("");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).getAllByText("Keep the retry once"),
  ).toHaveLength(1);
  expect(
    made.client
      .pendingSends("thread-router")
      .getSnapshot()
      .filter((send) => send.state !== "failed"),
  ).toHaveLength(1);
});

test("Continue uses the live restart reason while an older queue page remains on screen", async () => {
  const made = await idle();
  made.daemon.holdQueue("thread-router", "not_sent");
  await screen.findByRole("button", { name: "Try again" });
  // The previous page remains mounted; the revision push requests a replacement that is held.
  made.daemon.holdRequests("queue.get");
  act(() => made.daemon.holdQueue("thread-router", "restart"));
  const next = await screen.findByRole("button", { name: /^Continue$/ });
  made.daemon.restoreRequests();
  await userEvent.click(next);
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Stopped by a restart" })).toBeNull(),
  );
  const page = await made.client.request({
    type: "queue.get",
    threadId: ThreadId.parse("thread-router"),
  });
  expect(page.queue.paused).toBe(false);
});
