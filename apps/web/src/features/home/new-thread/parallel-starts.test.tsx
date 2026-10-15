import { workbench } from "@ace/fake-daemon";
import { act, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 20000 });

/** The fake daemon's worktree steps wait until the test runs them. */
function app() {
  const jobs: { run(): void; live: boolean }[] = [];
  const made = harness({
    worktreeSchedule(callback) {
      const job = { run: callback, live: true };
      jobs.push(job);
      return () => {
        job.live = false;
      };
    },
  });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const drain = () =>
    act(() => {
      for (let count = 0; count < 200 && jobs.length; count++) {
        const job = jobs.shift();
        if (job?.live) job.run();
      }
    });
  const titles = () => {
    const view = made.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? Object.values(view.threads).map((row) => row.title) : [];
  };
  return { ...made, drain, titles };
}

async function send(text: string) {
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), text);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.keyboard("{Enter}");
}

test("a second draft starts its own thread while the first one's worktree is still being made", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await send("First start");
  await screen.findByRole("heading", { level: 1, name: "First start" });
  await screen.findByRole("region", { name: "Creating a worktree" });

  // Back to New thread while the first worktree is still at its first step.
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await send("Second start");
  // The second message opens its own pending thread, not the first one's.
  await screen.findByRole("heading", { level: 1, name: "Second start" });
  await screen.findByRole("region", { name: "Creating a worktree" });

  await made.drain();
  await waitFor(() =>
    expect(made.titles()).toEqual(expect.arrayContaining(["First start", "Second start"])),
  );
}, 60_000);

test("a failed setup script shows its output and Continue starts the thread in the kept worktree", async () => {
  const made = app();
  made.daemon.workspace.git.failSetup("relay", ["bun install", "error: lockfile had changes"]);
  await made.open("/new?project=relay");
  await send("Needs its setup");
  await screen.findByRole("region", { name: "Creating a worktree" });
  await made.drain();

  const card = await screen.findByRole("region", { name: "Setup script failed" });
  expect(card.textContent).toContain("The worktree is ready but its setup script failed.");
  // The script's output is open with the card.
  const log = screen.getByRole("log", { name: "Worktree details" });
  expect(log.textContent).toContain("error: lockfile had changes");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Don't use worktree" })).toBeTruthy();

  made.daemon.workspace.git.failSetup("relay", undefined);
  await userEvent.click(screen.getByRole("button", { name: "Continue without setup" }));
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const started =
      view?.kind === "threads"
        ? Object.values(view.threads).find((row) => row.title === "Needs its setup")
        : undefined;
    expect(started?.details?.mode).toBe("worktree");
  });
}, 60_000);
