import { longHistory } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("a retired Cursor conversation stays readable and continues in a fresh Cursor thread", async () => {
  const app = harness();
  const scenario = longHistory(2);
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        provider: "cursor",
        backend: "acp",
        continuation: {
          state: "read_only",
          reason: "cursor_cli_retired",
          actionId: "thread.continue_new",
        },
      },
    })
    .runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Answer 2: route 2 renders its own panel.")).toBeTruthy();
  expect(await screen.findByText(/This Cursor CLI thread is read-only/)).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "First message in the new Cursor thread" }),
    "Continue the router work",
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
  await waitFor(() => expect(screen.queryByText(/This Cursor CLI thread is read-only/)).toBeNull());
  const nextFeed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(nextFeed).findByText("Continue the router work")).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "threads" });
  const threads = view?.kind === "threads" ? Object.values(view.threads) : [];
  expect(threads.find((thread) => thread.id !== "thread-router")).toMatchObject({
    provider: "cursor",
    backend: "cursor-sdk",
  });
  expect(threads.find((thread) => thread.id === "thread-router")?.continuation?.state).toBe(
    "read_only",
  );
});
