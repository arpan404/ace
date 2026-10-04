import { longHistory, replayCursor } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function open(scenario: "idle" | "busy") {
  const app = harness();
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else app.play(replayCursor()).runThrough("finding");
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const message = (await screen.findByRole("combobox", { name: "Message" })) as HTMLTextAreaElement;
  return { app, message };
}
const thread = (app: ReturnType<typeof harness>, id: string) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  return view?.kind === "thread" ? view.thread : undefined;
};
/** A menu that just closed still animates out; wait before opening the next. */
const menuClosed = () => waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

test("+ offers files, images, a mention and a command instead of a bare file dialog", async () => {
  const { message } = await open("idle");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const menu = await screen.findByRole("menu");
  for (const name of ["Files", "Images", "Mention a file", "Command"])
    expect(within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeTruthy();

  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Mention a file/ }));
  expect(message.value).toBe("@");
  expect(await screen.findByRole("listbox", { name: "Files" })).toBeTruthy();
});

test("the + menu is one line a row, and only a row that can't be used says why", async () => {
  await open("idle");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const menu = await screen.findByRole("menu");
  const rows = within(menu).getAllByRole("menuitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Files",
    "Images",
    "Mention a file@",
    "Command/",
    "Plan first",
    "An open pageOpen a page in the Browser first",
  ]);
  // Nothing is open in the thread's workspace yet: the page row says what it needs.
  const page = within(menu).getByRole("menuitem", { name: /^An open page/ });
  expect(page.getAttribute("aria-disabled")).toBe("true");
});

test("Plan first from + makes the thread read only until the plan is agreed", async () => {
  const { app } = await open("idle");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const plan = await screen.findByRole("menuitem", { name: /^Plan first/ });
  await waitFor(() => expect(plan.getAttribute("aria-disabled")).not.toBe("true"));
  await userEvent.click(plan);
  await waitFor(() => expect(thread(app, "thread-router")?.permission?.override).toBe("read-only"));
});

test("a file mentioned once comes first when + › Mention a file opens the list", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "Look at @check");
  await screen.findByRole("listbox", { name: "Files" });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  const picked = message.value.trim().slice("Look at @".length);
  await userEvent.clear(message);

  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Mention a file/ }));
  const files = await screen.findByRole("listbox", { name: "Files" });
  const first = within(files).getAllByRole("option")[0];
  if (!first) throw new Error("no files listed");
  expect(first.textContent).toContain(`${picked} · recent`);
  await userEvent.click(first);
  expect(message.value).toBe(`@${picked} `);
});

test("Command waits for an empty message, and says so", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "Already writing");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const command = await screen.findByRole("menuitem", { name: /^Command/ });
  expect(command.getAttribute("aria-disabled")).toBe("true");
  expect(command.textContent).toContain("Commands go at the start of an empty message");
});

test("a search that finds nothing says so instead of closing", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "@zzqqxx");
  expect(await screen.findByText("No files match “zzqqxx”")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("No files match “zzqqxx”")).toBeNull();
});

test("approvals show the thread's mode and what the provider gates, and change from the footer", async () => {
  const { app } = await open("busy");
  const chip = await screen.findByRole("button", { name: "Approvals: Auto-review" });
  await userEvent.click(chip);
  const auto = await screen.findByRole("menuitemradio", { name: "Auto-review" });
  expect(auto.getAttribute("aria-checked")).toBe("true");
  // Each mode in one line; what the provider gates, said once for the mode in effect.
  expect(auto.textContent).toContain("Approves low-risk actions, asks the rest");
  expect(
    screen.getByText("Auto-review: Gates edits, shell commands, network and protected reads"),
  ).toBeTruthy();
  const full = screen.getByRole("menuitemradio", { name: "Full access" });
  expect(full.textContent).toContain("Edits, runs and fetches without asking");

  await userEvent.click(screen.getByRole("menuitemradio", { name: "Read only" }));
  // The agent is mid-turn: the new mode waits for the turn to end.
  expect(
    await screen.findByRole("button", { name: "Approvals: Read only, applies after this turn" }),
  ).toBeTruthy();
  expect(thread(app, "thread-replay-cursor")?.permission?.override).toBe("read-only");

  await menuClosed();
  await userEvent.click(screen.getByRole("button", { name: /^Approvals: Read only/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Use the default/ }));
  await waitFor(() => expect(thread(app, "thread-replay-cursor")?.permission?.override).toBeNull());
});

test("the model chip opens effort and speed for the thread's model", async () => {
  await open("busy");
  // The daemon hasn't reported this thread's effort: it runs at the provider's default.
  const popover = await openModelControl("Model: Opus 4.1, personal, provider default effort");
  expect(within(popover).getByText("Default effort")).toBeTruthy();
  expect(within(popover).getByRole("button", { name: "Change model: Opus 4.1" })).toBeTruthy();
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  expect(slider.getAttribute("aria-valuetext")).toBe("Not set");
  // Opus has no faster tier.
  expect(
    within(popover).getByRole("button", { name: "Fast mode" }).getAttribute("aria-disabled"),
  ).toBe("true");
});

test("effort from the slider goes with the next message and applies to its turn", async () => {
  const { app, message } = await open("busy");
  const popover = await openModelControl(/^Model: Opus 4\.1/);
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  expect(within(popover).getByText("High")).toBeTruthy();
  await closeModelControl();
  // Nothing changes on the daemon until the message goes.
  expect(
    await screen.findByRole("button", { name: "Model: Opus 4.1, personal, High effort" }),
  ).toBeTruthy();
  expect(thread(app, "thread-replay-cursor")?.switch).toBeUndefined();

  await userEvent.type(message, "Also cap the replay at 200{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  // Once the agent and its background relay stop, the queued message starts a turn at High.
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
  app.daemon.apply("thread-replay-cursor", [
    { type: "background.ended", task: "relay", status: "stopped" },
  ]);
  await waitFor(() =>
    expect(thread(app, "thread-replay-cursor")?.live?.options).toMatchObject({ effort: "high" }),
  );
});

test("reset drops the effort picked for the next message, so it can steer again", async () => {
  const { message } = await open("busy");
  const popover = await openModelControl(/^Model: Opus 4\.1/);
  const reset = within(popover).getByRole("button", { name: "Reset effort and speed" });
  expect(reset.getAttribute("aria-disabled")).toBe("true");
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  expect(reset.getAttribute("aria-disabled")).toBeNull();
  await userEvent.click(reset);
  expect(within(popover).getByRole("slider", { name: "Effort" }).ariaValueText).toBe("Not set");
  await closeModelControl();
  expect(
    screen.getByRole("button", { name: "Model: Opus 4.1, personal, provider default effort" }),
  ).toBeTruthy();

  // A message carrying a new effort always waits for the next turn; without one, ⌘↵ steers.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  await userEvent.type(message, "Cap it at 500 instead{Meta>}{Enter}{/Meta}");
  expect(await within(feed).findByText("Cap it at 500 instead")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("a model without effort levels says so instead of offering a slider", async () => {
  await open("idle");
  const popover = await openModelControl(/^Model: Sonnet 4.5 \(OpenCode\)/);
  expect(within(popover).getByText("Sonnet 4.5 (OpenCode) has no effort levels")).toBeTruthy();
  expect(within(popover).queryByRole("slider")).toBeNull();
});
test("while the agent works, a draft offers Queue and never turns into Stop", async () => {
  const { message } = await open("busy");
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.type(message, "Also check cold start");
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
});

test("offline, the model chip keeps the thread's last-known model and says changes wait", async () => {
  const { app } = await open("busy");
  await screen.findByRole("button", { name: /^Model: Opus 4\.1, personal/ });
  act(() => app.client.networkOnline(false));
  await screen.findByText(/^Offline\./);
  const chip = screen.getByRole("button", { name: /^Model: Opus 4\.1/ });
  await userEvent.click(chip);
  expect(await screen.findByText("Offline: changes apply when the daemon is back")).toBeTruthy();
});

test("a switch queued to a provider with no catalog models keeps showing it across a reconnect", async () => {
  const { app } = await open("busy");
  await screen.findByRole("button", { name: /^Model: Opus 4\.1, personal/ });
  // Another device moves the thread to Pi, which lists no models in the catalog.
  app.daemon.command({
    id: CommandId.parse("switch-to-pi"),
    deviceId: DeviceId.parse("phone"),
    payload: {
      type: "thread.switch",
      threadId: ThreadId.parse("thread-replay-cursor"),
      selection: { provider: "pi", options: {} },
    },
  });
  expect(await screen.findByRole("button", { name: /^Model: Pi default/ })).toBeTruthy();

  act(() => app.client.networkOnline(false));
  await screen.findByText(/^Offline\./);
  expect(screen.getByRole("button", { name: /^Model: Pi default/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Model: Opus/ })).toBeNull();

  act(() => app.client.networkOnline(true));
  await waitFor(() => expect(screen.queryByText(/^Offline\./)).toBeNull());
  expect(screen.getByRole("button", { name: /^Model: Pi default/ })).toBeTruthy();
});
