import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 20000 });

const message = () => screen.findByRole("combobox", { name: "Message" });

test("a stale Git lock says so by name, and Clear stale lock lets the start go again", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.workspace.git.lock("relay", "/fake/relay");
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Blocked by a lock");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.keyboard("{Enter}");

  // Back in New thread with the message, and the daemon's own words for the failure.
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  const notice = (await screen.findByText(/Git is locked/)).closest('[role="alert"]');
  if (!(notice instanceof HTMLElement)) throw new Error("no notice");
  expect(notice.textContent).toContain("/fake/relay");
  await waitFor(async () => expect((await message()).textContent).toBe("Blocked by a lock"));

  // Clearing asks first.
  await userEvent.click(within(notice).getByRole("button", { name: "Clear stale lock" }));
  const confirm = await screen.findByRole("dialog", { name: "Clear the stale Git lock?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Clear lock" }));
  await screen.findByText("Retry to start the thread.");

  await userEvent.click(await message());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: /^Worktree ready/ });
  const view = made.daemon.snapshot({ kind: "threads" });
  expect(
    view?.kind === "threads" &&
      Object.values(view.threads).some((thread) => thread.title === "Blocked by a lock"),
  ).toBe(true);
}, 60_000);
