import { flakyCheckout, replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openThread(which: "replay" | "checkout" = "replay") {
  const app = harness();
  if (which === "replay") app.play(replayCursor()).runThrough("finding");
  else app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open(which === "replay" ? "/t/thread-replay-cursor" : "/t/thread-checkout");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

test("Run starts the project's default script in the bottom terminal", async () => {
  await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Run bun run dev:relay" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  expect(within(bottom).getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(await screen.findByText("Running bun run dev:relay")).toBeTruthy();
});

test("Run's picker runs another script", async () => {
  await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Choose a script" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /bun run soak/ }));
  expect(await screen.findByText("Running bun run soak --subscribers 500")).toBeTruthy();
});

test("opening in another editor makes it the default", async () => {
  await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Choose an editor" }));
  expect(await screen.findByRole("menuitem", { name: /Cursor\s*default/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
  expect(await screen.findByText("Opened in Zed")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Choose an editor" }));
  expect(await screen.findByRole("menuitem", { name: /Zed\s*default/ })).toBeTruthy();
});

test("the git control walks the branch from Commit to Push to Create PR to the PR", async () => {
  await openThread("checkout");
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  await userEvent.click(await screen.findByRole("button", { name: "Commit" }));
  expect(await screen.findByText("Committed · the agent wrote the message")).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Push" }));
  await userEvent.click(await screen.findByRole("button", { name: "Create PR" }));
  const pr = await screen.findByRole("button", { name: "PR #221" });
  await userEvent.click(pr);
  expect(opened).toHaveBeenCalledWith(
    "https://github.com/acme/acme-web/pull/221",
    "_blank",
    "noopener,noreferrer",
  );
  opened.mockRestore();
});

test("View diff in the git menu shows the Changes tab", async () => {
  await openThread();
  await userEvent.click(await screen.findByRole("button", { name: "Git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /View diff/ }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    within(panel)
      .getByRole("tab", { name: /^Changes/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("renaming from the ⋯ menu changes the title", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.clear(field);
  await userEvent.type(field, "Cold-start replay cap{Enter}");
  expect(
    await screen.findByRole("heading", { level: 1, name: "Cold-start replay cap" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("archiving from the ⋯ menu leaves the thread", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(await screen.findByText("Archived · Replay cursor resets on every resume")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
});

test("snoozing from the ⋯ menu confirms until when", async () => {
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Snooze" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Tomorrow 9:00" }));
  expect(await screen.findByText("Snoozed until tomorrow 9:00")).toBeTruthy();
});
