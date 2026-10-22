import { longHistory, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";

beforeEach(() => {
  resetDismissed();
  resetSendStore();
});
afterEach(() => vi.restoreAllMocks());
const field = () => screen.getByRole("combobox", { name: "Message" });
const starting = () => screen.queryByRole("list", { name: "Starting threads" });

async function failedStart() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.refuseCommands("model_unavailable", "thread.create");
  await made.open("/new?project=relay");
  await screen.findByRole("button", { name: /^Model: Opus/ });
  await userEvent.type(field(), "Start that never went{Enter}");
  const rows = await screen.findByRole("list", { name: "Starting threads" });
  const row = await within(rows).findByRole("link", { name: /Start that never went/ });
  await waitFor(() => expect(row.textContent).toContain("Not sent"));
  return made;
}

test("discarding a new thread that wasn't sent takes it out of Unsent and leaves its page", async () => {
  await failedStart();
  await userEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(starting()).toBeNull());
  expect(within(screen.getByRole("main")).queryByText("Not sent")).toBeNull();
  expect(screen.queryByText("Start that never went")).toBeNull();
});

test("Undo brings a discarded unsent thread back with Retry", async () => {
  await failedStart();
  await userEvent.click(
    within(starting()!).getByRole("button", { name: "Discard Start that never went" }),
  );
  await waitFor(() => expect(starting()).toBeNull());
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  const rows = await screen.findByRole("list", { name: "Starting threads" });
  await userEvent.click(within(rows).getByRole("link", { name: /Start that never went/ }));
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
});

test("discarding a follow-up that wasn't sent keeps the thread open without it", async () => {
  const made = harness();
  made.play(longHistory(2)).runUntilBlocked();
  await made.open("/t/thread-router");
  made.daemon.refuseCommands("model_unavailable", "thread.send");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Drop me{Enter}");
  await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
  expect(screen.queryByText("Drop me")).toBeNull();
  expect(field()).toBeTruthy();
});
