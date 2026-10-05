import { replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseModel, closeModelControl, openModelControl } from "@/test/model-control.ts";

/*
 * Approval mode and model switches show the person's choice at once, marked as waiting, and
 * only a refusal from the daemon takes it back (UX audit SY-11). Offline they wait in the
 * outbox rather than fail.
 */

beforeEach(() => localStorage.clear());

const threadId = "thread-replay-cursor";

/** A Claude Code thread mid-turn. */
async function open() {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("feed", { name: "Transcript" });
  await screen.findByRole("button", { name: /^Model: Opus 4\.1, personal/ });
  return app;
}
const thread = (app: ReturnType<typeof harness>) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  return view?.kind === "thread" ? view.thread : undefined;
};
async function offline(app: ReturnType<typeof harness>) {
  act(() => app.client.networkOnline(false));
  await screen.findByText(/^Offline ·/);
}
async function online(app: ReturnType<typeof harness>) {
  act(() => app.client.networkOnline(true));
  await waitFor(() => expect(screen.queryByText(/^Offline ·/)).toBeNull());
}
async function chooseApprovals(from: string, mode: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Approvals: ${from}` }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: mode }));
}

test("an approval mode chosen offline shows at once and reaches the daemon once it's back", async () => {
  const app = await open();
  await offline(app);
  await chooseApprovals("Auto-review", "Full access");

  const chip = await screen.findByRole("button", {
    name: "Approvals: Auto-review, Full access will apply when reconnected",
  });
  expect(chip.textContent).toBe("Auto-review → Full access");
  expect(thread(app)?.permission?.override).toBeNull();

  await online(app);
  await waitFor(() => expect(thread(app)?.permission?.override).toBe("full-access"));
  expect(
    await screen.findByRole("button", {
      name: "Approvals: Auto-review, Full access applies at the agent's next turn",
    }),
  ).toBeTruthy();
});

test("an approval mode the daemon refuses goes back to the one in effect, with a toast", async () => {
  const app = await open();
  app.daemon.refuseCommands("forbidden", "thread.permission.set");
  await chooseApprovals("Auto-review", "Read only");

  expect(await screen.findByText("Couldn't change approvals")).toBeTruthy();
  expect(screen.getByText("This device isn't allowed to do that.")).toBeTruthy();
  const chip = await screen.findByRole("button", { name: "Approvals: Auto-review" });
  expect(chip.textContent).toBe("Auto-review");
  expect(thread(app)?.permission?.override).toBeNull();
});

test("offline, the model popover still changes effort and the account, which go once the daemon is back", async () => {
  const app = await open();
  await offline(app);
  const popover = await openModelControl(/^Model: Opus 4\.1, personal/);
  expect(within(popover).getByText("Offline: changes apply when the daemon is back")).toBeTruthy();
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  await userEvent.click(within(popover).getByRole("button", { name: "Account work" }));
  await closeModelControl();

  // The chip names the new account at once and says the switch is waiting.
  const chip = await screen.findByRole("button", { name: "Model: Opus 4.1, work, High effort" });
  expect(chip.getAttribute("aria-description")).toBe(
    "Switches from Opus 4.1 on personal · Will apply when reconnected",
  );
  expect(thread(app)?.switch).toBeUndefined();

  await online(app);
  await waitFor(() =>
    expect(thread(app)?.switch).toMatchObject({
      state: "queued",
      selection: { provider: "claude", instanceId: "claude-work" },
    }),
  );
  // The agent is mid-turn: the switch waits for its next turn, and the chip says so.
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Model: Opus 4.1, work, High effort" })
        .getAttribute("aria-description"),
    ).toBe("Switches from Opus 4.1 on personal · Applies at the agent's next turn"),
  );
});

test("a model switch shows the model it leaves until the agent's next turn", async () => {
  await open();
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 4\.1/);
  const dialog = await screen.findByRole("dialog", { name: "Switch to Codex?" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Switch to/ }));

  const chip = await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ });
  expect(chip.textContent).toContain("Opus 4.1 →GPT-5 Codex");
  expect(chip.getAttribute("aria-description")).toMatch(/^Switches from Opus 4\.1 on personal · /);
});

test("a model switch the daemon refuses goes back to the model in effect, with a toast", async () => {
  const app = await open();
  app.daemon.refuseCommands("provider_unavailable", "thread.switch");
  await userEvent.click(
    within(await openModelControl(/^Model: Opus 4\.1, personal/)).getByRole("button", {
      name: "Account work",
    }),
  );

  expect(await screen.findByText("Couldn't switch the model")).toBeTruthy();
  expect(screen.getByText("That provider isn't installed or signed in.")).toBeTruthy();
  await closeModelControl();
  const chip = screen.getByRole("button", { name: /^Model: Opus 4\.1, personal/ });
  expect(chip.getAttribute("aria-description")).toBeNull();
  expect(thread(app)?.switch).toBeUndefined();
});
