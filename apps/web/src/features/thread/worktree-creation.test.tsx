import { workbench } from "@ace/fake-daemon";
import { WorkspaceId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * A new thread's worktree as the person watches it being made: its steps under the first
 * message, checkout's progress, the details log, Cancel, Don't use worktree, Retry, and the
 * one line it folds to once made. The fake daemon's steps are run one at a time.
 */
function app() {
  const jobs: { run(): void; live: boolean }[] = [];
  let now = 1_000;
  const made = harness({
    clock: () => (now += 1),
    worktreeSchedule(callback, delay) {
      const job = {
        run() {
          now += delay;
          callback();
        },
        live: true,
      };
      jobs.push(job);
      return () => {
        job.live = false;
      };
    },
  });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  /** Run the daemon's next creation step. */
  const step = () =>
    act(() => {
      let job = jobs.shift();
      while (job && !job.live) job = jobs.shift();
      if (!job) throw new Error("No creation step is waiting");
      job.run();
    });
  /** Run steps until `done` holds. */
  const stepUntil = async (done: () => boolean) => {
    for (let count = 0; count < 20 && !done(); count++) await step();
    expect(done()).toBe(true);
  };
  const threads = () => {
    const view = made.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? Object.values(view.threads) : [];
  };
  return { ...made, step, stepUntil, threads };
}

const isNew = (id: string) => /^thread-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id);

async function startWorktree(made: ReturnType<typeof app>, text: string) {
  await made.open("/new?project=relay");
  // The first open compiles New thread's route; give it the time a busy machine needs.
  const worktree = await screen.findByRole("checkbox", { name: "Worktree" }, { timeout: 10_000 });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), `${text}{Enter}`);
  return screen.findByRole("region", { name: "Creating a worktree" });
}

const checkout = () => screen.queryByRole("progressbar", { name: "Checking out files" });

test("a worktree's steps advance under the first message, with checkout's percent", async () => {
  const made = app();
  const card = await startWorktree(made, "Add jitter to the retry backoff");
  const steps = () => within(card).getByRole("list", { name: "Steps" });
  expect(within(steps()).getByRole("listitem", { current: "step" }).textContent).toContain(
    "Preparing workspace",
  );

  await made.stepUntil(() => checkout()?.getAttribute("aria-valuenow") === "48");
  // Every step before checkout is done; checkout is the one in flight, at 48%.
  const items = within(steps()).getAllByRole("listitem");
  const running = within(steps()).getByRole("listitem", { current: "step" });
  expect(running.textContent).toContain("Checking out files");
  expect(running.textContent).toContain("48%");
  for (const done of items.filter((item) => item !== running))
    expect(within(done).getByRole("img", { name: "Done" })).toBeTruthy();
  expect(items[0]?.textContent).toMatch(/^Preparing workspace1\.5s$/);

  // Progress lives once in the transcript. The next message can be drafted, but not sent.
  expect(screen.queryByRole("region", { name: "Worktree" })).toBeNull();
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Approvals:/ })).toBeTruthy();
  const input = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Also cover the reconnect case");
  expect(input.textContent).toBe("Also cover the reconnect case");
  expect(screen.getByRole("button", { name: /^Send$/ }).getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  expect(await screen.findByRole("listbox", { name: "Add and commands" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  // The bubble leaves its sending state to the card.
  expect(screen.queryByText(/Sending…|Still waiting/)).toBeNull();

  // More details opens the daemon's redacted log.
  await userEvent.click(within(card).getByRole("button", { name: "More details" }));
  expect(within(card).getByRole("log", { name: "Worktree details" }).textContent).toContain(
    "Checking out files: 48%",
  );
  expect(made.threads().some((thread) => isNew(thread.id))).toBe(false);
}, 30_000);

test("once made, the card folds to one line that opens on its steps and log", async () => {
  const made = app();
  made.daemon.services.settings.seed({
    "host.displayName": "Workshop Mac",
    "host.icon": { kind: "desktop" },
  });
  await startWorktree(made, "Profile the relay startup");
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Keep the retries bounded too",
  );
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["Reconnect reproduction steps"], "reconnect.txt", { type: "text/plain" }),
  );
  const attachments = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(attachments).queryByRole("progressbar")).toBeNull());
  expect(within(attachments).getByText("reconnect.txt")).toBeTruthy();
  await made.stepUntil(() => made.threads().some((thread) => isNew(thread.id)));

  // The real thread opens; its first message keeps how the worktree was made, folded.
  const line = await screen.findByRole("button", { name: /^Worktree ready · ace\/[\w-]+ · \d+s$/ });
  expect(screen.queryByRole("region", { name: "Creating a worktree" })).toBeNull();
  const transcript = screen.getByRole("feed", { name: "Transcript" });
  expect(await within(transcript).findByText("Workshop Mac")).toBeTruthy();
  expect(within(transcript).getByRole("img", { name: "desktop machine icon" })).toBeTruthy();
  expect(line.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(line);
  const steps = screen.getByRole("list", { name: "Steps" });
  expect(
    within(steps)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Preparing workspace1.5s",
    "Fetching the base branch1.5s",
    "Creating the branch1.5s",
    "Checking out files11s",
    "Running setup1.5s",
  ]);
  expect(screen.getByRole("log", { name: "Worktree details" }).textContent).toContain(
    "Worktree setup",
  );
  expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
    "Keep the retries bounded too",
  );
  expect(
    within(screen.getByRole("list", { name: "Attachments" })).getByText("reconnect.txt"),
  ).toBeTruthy();
  // The composer is the thread's own again.
  expect(screen.getByRole("combobox", { name: "Message" }).getAttribute("aria-disabled")).not.toBe(
    "true",
  );
}, 30_000);

test("Cancel stops the worktree, keeps the message unsent and offers Retry or the local checkout", async () => {
  const made = app();
  const card = await startWorktree(made, "Trace the reconnect storm");
  await made.stepUntil(() => checkout() !== null);

  await userEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  const stopped = await screen.findByRole("region", { name: "Worktree cancelled" });
  expect(within(stopped).getByRole("img", { name: "Stopped" })).toBeTruthy();
  expect(within(stopped).getByRole("alert").textContent).toBe(
    "Your message hasn't been sent. Retry, or send it on the local checkout.",
  );
  expect(within(stopped).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(within(stopped).getByRole("button", { name: "Don't use worktree" })).toBeTruthy();
  expect(within(stopped).queryByRole("button", { name: "Cancel" })).toBeNull();
  // The daemon made no thread, and the bubble doesn't add a "Not sent" of its own.
  expect(made.threads().some((thread) => isNew(thread.id))).toBe(false);
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(screen.queryByRole("region", { name: "Worktree" })).toBeNull();

  // Retry makes it from the start, under the same message.
  await userEvent.click(within(stopped).getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "Creating a worktree" });
  await made.stepUntil(() => made.threads().some((thread) => isNew(thread.id)));
  expect(await screen.findByRole("button", { name: /^Worktree ready/ })).toBeTruthy();
  const created = made.threads().filter((thread) => isNew(thread.id));
  expect(created).toHaveLength(1);
  // The message's own send settles with the retried create's receipt.
  const commandId = created[0]?.id.slice("thread-".length) ?? "";
  await waitFor(() =>
    expect(made.client.intent(commandId).getSnapshot()).toMatchObject({
      state: "acked",
      threadId: created[0]?.id,
    }),
  );
}, 30_000);

test("Don't use worktree starts the thread on the local checkout and sends the message", async () => {
  const made = app();
  const card = await startWorktree(made, "Bump the retry budget");
  await made.stepUntil(() => checkout() !== null);

  await userEvent.click(within(card).getByRole("button", { name: "Don't use worktree" }));
  const line = await screen.findByRole("button", { name: /^Using the local checkout · / });
  expect(line).toBeTruthy();
  const created = made.threads().find((thread) => isNew(thread.id));
  expect(created?.details?.mode).toBe("local");
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).getAllByText("Bump the retry budget")).toHaveLength(1);
}, 30_000);

test("a worktree that fails says so, with Retry and Don't use worktree", async () => {
  const made = app();
  await made.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  // A base the project doesn't have: the daemon can't make the worktree.
  await act(() =>
    made.client.enqueue(
      {
        type: "thread.create",
        workspaceId: WorkspaceId.parse("relay"),
        provider: "codex",
        mode: "worktree",
        base: { ref: "no-such-branch" },
        input: [{ type: "text", text: "Start from a branch that is gone" }],
      },
      "worktree-fails",
    ),
  );
  const starting = await screen.findByRole("list", { name: "Starting threads" });
  await userEvent.click(within(starting).getByRole("link", { name: /^Start from a branch/ }));
  await screen.findByRole("region", { name: "Creating a worktree" });
  await made.stepUntil(
    () => screen.queryByRole("region", { name: "Couldn't create the worktree" }) !== null,
  );

  const failed = screen.getByRole("region", { name: "Couldn't create the worktree" });
  expect(within(failed).getByRole("alert").textContent).toBe(
    "We couldn't create the worktree. Try again or use the local checkout.",
  );
  expect(within(failed).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Worktree" })).toBeNull();

  // Retry runs the steps again.
  await userEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "Creating a worktree" });
  await made.stepUntil(
    () => screen.queryByRole("region", { name: "Couldn't create the worktree" }) !== null,
  );

  // The local checkout has no such base to miss: the thread starts there.
  await userEvent.click(
    within(screen.getByRole("region", { name: "Couldn't create the worktree" })).getByRole(
      "button",
      { name: "Don't use worktree" },
    ),
  );
  await screen.findByRole("button", { name: /^Using the local checkout · / });
  await waitFor(() =>
    expect(
      made.threads().find((thread) => thread.title === "Start from a branch that is gone")?.details
        ?.mode,
    ).toBe("local"),
  );
  await waitFor(() =>
    expect(made.client.intent("worktree-fails").getSnapshot()?.state).toBe("acked"),
  );
}, 30_000);
