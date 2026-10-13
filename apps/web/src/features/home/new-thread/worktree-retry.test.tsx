import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 20000 });

/*
 * A New thread start whose worktree can't be made comes back to New thread: the message (and
 * its files) in the composer to edit and send again, the reason in the composer's top strip.
 */

const failure = "We couldn't create the worktree. Try again or use the local checkout.";
const message = () => screen.getByRole("combobox", { name: "Message" });

async function startThatFails(text: string, file?: File) {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  // The daemon makes the worktree's steps, then can't start the thread in it.
  made.daemon.refuseCommands("workspace_unavailable", "thread.create");
  await made.open("/new?project=relay");
  const worktree = await screen.findByRole("checkbox", { name: "Worktree" }, { timeout: 10_000 });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await screen.findByRole("button", { name: /^Model: / });
  if (file) {
    await userEvent.upload(screen.getByLabelText("Files to attach"), file);
    await screen.findByRole("button", { name: `Remove ${file.name}` });
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: `Uploading ${file.name}` })).toBeNull(),
    );
  }
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), text);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("region", { name: "Creating a worktree" });
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  return made;
}

test("a worktree that can't be made puts the message and its file back in New thread, with the reason above it", async () => {
  await startThatFails(
    "Keep every word of this",
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(message().textContent).toBe("Keep every word of this"));
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Project: relay" })).toBeTruthy();
  const reason = await screen.findByText(failure);
  expect(reason.closest('[role="alert"]')).toBeTruthy();
  // The reason takes the composer's one strip; nothing renders below the composer.
  expect(screen.queryByRole("region", { name: "Where this thread runs" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Creating a worktree" })).toBeNull();
}, 60_000);

test("the returned message, edited, starts the thread with the edited text", async () => {
  const made = await startThatFails("First try");
  await screen.findByText(failure);
  await waitFor(() => expect(message().textContent).toBe("First try"));
  made.daemon.restoreRequests();

  await userEvent.click(message());
  await userEvent.keyboard("{Control>}a{/Control}{Meta>}a{/Meta}{Backspace}");
  await userEvent.type(message(), "Second try, edited");
  await userEvent.keyboard("{Enter}");

  // The strip's reason goes with the send; the thread starts on the edited message.
  await waitFor(() => expect(screen.queryByText(failure)).toBeNull());
  await screen.findByRole("button", { name: /^Worktree ready/ });
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).getByText("Second try, edited")).toBeTruthy();
  expect(within(feed).queryByText("First try")).toBeNull();
}, 60_000);

test("Don't use worktree in the strip sends the returned message on the local checkout", async () => {
  const made = await startThatFails("Run it in my checkout");
  await userEvent.click(
    within((await screen.findByText(failure)).closest('[role="alert"]') as HTMLElement).getByRole(
      "button",
      { name: "Don't use worktree" },
    ),
  );
  // The strip shows where the thread runs again, now the project's checkout.
  const strip = await screen.findByRole("region", { name: "Where this thread runs" });
  expect(
    within(strip).getByRole("checkbox", { name: "Worktree" }).getAttribute("aria-checked"),
  ).toBe("false");
  made.daemon.restoreRequests();
  await userEvent.click(message());
  await userEvent.keyboard("{Enter}");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await waitFor(() => expect(within(feed).getByText("Run it in my checkout")).toBeTruthy());
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const started =
      view?.kind === "threads"
        ? Object.values(view.threads).filter((thread) => thread.title === "Run it in my checkout")
        : [];
    expect(started.map((thread) => thread.details?.mode)).toEqual(["local"]);
  });
}, 60_000);
