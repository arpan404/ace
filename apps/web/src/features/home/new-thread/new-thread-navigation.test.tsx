import { facts, workbench } from "@ace/fake-daemon";
import { CommandPayload } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { fallback } from "@/boot/connection.tsx";
import { newThreadDraftKey } from "@/lib/new-thread-draft-key.ts";
import { createAttemptsKey, readCreateAttempts, saveCreateAttempt } from "./create-attempt.ts";

test.each([
  { entry: "sidebar", recovery: false },
  { entry: "shortcut", recovery: false },
  { entry: "sidebar", recovery: true },
  { entry: "shortcut", recovery: true },
])(
  "New thread opened through $entry stays open while the old thread streams (saved recovery: $recovery)",
  async ({ entry, recovery }) => {
    const user = userEvent.setup();
    const storage = memoryKeyValue();
    storage.setItem("ace.home.newThread", JSON.stringify({ project: "relay" }));
    const commandId = "previous-create";
    const threadId = `thread-${commandId}`;
    const history = createMemoryHistory({ initialEntries: [`/t/${threadId}`] });
    const app = harness({ storage, history });
    for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
    await app.client.start();
    const payload = CommandPayload.parse({
      type: "thread.create",
      workspaceId: "relay",
      provider: "claude",
      mode: "local",
      input: [{ type: "text", text: "Previously accepted thread" }],
    });
    if (payload.type !== "thread.create") throw new Error("Expected thread creation");
    await app.client.enqueue(payload, commandId);
    await waitFor(() => expect(app.client.intent(commandId).getSnapshot()?.result?.ok).toBe(true));
    // A lost window can leave the recovery journal behind after the daemon accepted the start.
    const key = createAttemptsKey(fallback.url, "fake");
    if (recovery)
      saveCreateAttempt(storage, key, {
        hostId: app.daemon.hostId,
        commandId,
        draftKey: newThreadDraftKey(app.daemon.hostId, "relay"),
        payload,
      });
    await app.open(`/t/${threadId}`);
    await screen.findByRole("heading", { level: 1, name: "Previously accepted thread" });
    if (entry === "sidebar") {
      const link = await screen.findByRole("link", { name: "New thread" });
      await user.pointer({ keys: "[MouseLeft>]", target: link });
      act(() => app.daemon.apply(threadId, [facts.stream("root", "reading", " Still working.")]));
      await user.pointer({ keys: "[/MouseLeft]", target: link });
    } else await user.keyboard("{Meta>}n{/Meta}");
    await waitFor(() => expect(readCreateAttempts(storage, key)).toEqual([]));
    await screen.findByRole("heading", { level: 1, name: "New thread" });
    expect(history.location.pathname).toBe("/new");
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe("");
    act(() => app.daemon.apply(threadId, [facts.stream("root", "reading", " More live output.")]));
    expect(history.location.pathname).toBe("/new");
    expect(screen.getByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
  },
);
