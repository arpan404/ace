import { longHistory, replayCursor } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function open(
  scenario: "idle" | "busy",
  setup: (app: ReturnType<typeof harness>) => void = () => {},
) {
  const app = harness();
  setup(app);
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else app.play(replayCursor()).runThrough("finding");
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, message };
}
const thread = (app: ReturnType<typeof harness>, id: string) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  return view?.kind === "thread" ? view.thread : undefined;
};
test("Add offers context without commands and Files opens the mention picker", async () => {
  const { message } = await open("idle");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const menu = await screen.findByRole("listbox", { name: "Add" });
  expect(within(menu).getByText("Add")).toBeTruthy();
  expect(within(menu).queryByText("Skills")).toBeNull();
  await userEvent.click(within(menu).getByRole("option", { name: /Files and folders/ }));
  await waitFor(() => expect(message.textContent).toBe("@ "));
  expect(await screen.findByRole("listbox", { name: "Files and threads" })).toBeTruthy();
});

test("providers without native plan mode do not offer it in the catalog", async () => {
  const { app, message } = await open("idle");
  await userEvent.type(message, "/");
  const menu = await screen.findByRole("listbox", { name: "Commands" });
  expect(within(menu).queryByRole("option", { name: /Plan mode/ })).toBeNull();
  expect(thread(app, "thread-router")?.permission?.override).toBeNull();
});

test("Plan mode changes Claude's next turn through the native approval control", async () => {
  const { app, message } = await open("busy");
  await userEvent.type(message, "/plan");
  const menu = await screen.findByRole("listbox", { name: "Commands" });
  await userEvent.click(within(menu).getByRole("option", { name: /Plan mode/ }));
  await waitFor(() =>
    expect(thread(app, "thread-replay-cursor")?.permission?.override).toBe("plan"),
  );
});

test("a file mentioned once comes first in the next @ picker", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "Look at @check");
  await screen.findByRole("listbox", { name: "Files and threads" });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  const picked = (message.textContent ?? "").trim().slice("Look at @".length);
  await userEvent.clear(message);
  await userEvent.type(message, "@");
  const files = await screen.findByRole("listbox", { name: "Files and threads" });
  expect(within(files).getAllByRole("option")[0]?.textContent).toContain(picked);
});

test("a file query that matches nothing says so until Escape dismisses it", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "@zzqqxx");
  expect(await screen.findByText("No matching suggestions")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("No matching suggestions")).toBeNull();
});

test("permission picker offers three approval presets with exact Claude selectors", async () => {
  const { app } = await open("busy");
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Auto review" }));
  const options = await screen.findAllByRole("menuitemradio");
  expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
    "Manual",
    "Auto review",
    "Full access",
  ]);
  expect(
    options
      .filter((option) => option.getAttribute("aria-checked") === "true")
      .map((option) => option.getAttribute("aria-label")),
  ).toEqual(["Auto review"]);
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Manual" }));
  await waitFor(() =>
    expect(thread(app, "thread-replay-cursor")?.permission?.override).toBe("default"),
  );
});

test("a mode chosen mid-turn takes over at the agent's next turn", async () => {
  const { app, message } = await open("busy");
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Auto review" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Full access" }));
  expect(
    await screen.findByRole("button", {
      name: "Approvals: Full access, applies at the agent's next turn",
    }),
  ).toBeTruthy();

  // The turn ends; the next message starts a turn under the new mode.
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
  app.daemon.apply("thread-replay-cursor", [
    { type: "background.ended", task: "relay", status: "stopped" },
  ]);
  await userEvent.type(message, "Now cap the replay{Enter}");
  await screen.findByRole("button", { name: "Approvals: Full access" });
  expect(thread(app, "thread-replay-cursor")?.permission).toMatchObject({
    effective: "bypassPermissions",
    pending: false,
  });
});

test("the model chip opens effort and speed for the thread's model", async () => {
  await open("busy");
  // The daemon hasn't reported this thread's effort: it runs at the provider's default.
  const popover = await openModelControl("Model: Opus 5.5, Personal, Medium effort (default)");
  expect(within(popover).getByRole("listbox", { name: "Models" })).toBeTruthy();
  expect(within(popover).getByRole("button", { name: "Medium" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(within(popover).queryByRole("button", { name: "Fast" })).toBeNull();
  expect(within(popover).queryByRole("button", { name: "Reset" })).toBeNull();
});

test("effort chosen in the menu goes with the next message and applies to its turn", async () => {
  const { app, message } = await open("busy");
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  await userEvent.click(within(popover).getByRole("button", { name: "High" }));
  expect(within(popover).getByRole("button", { name: "High" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await closeModelControl();
  // Nothing changes on the daemon until the message goes.
  expect(
    await screen.findByRole("button", { name: "Model: Opus 5.5, Personal, High effort" }),
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

test("an unresolved running effort stays untouched until the predefined next turn starts", async () => {
  const { app, message } = await open("busy");
  expect(thread(app, "thread-replay-cursor")?.live?.options?.effort).toBeUndefined();
  await userEvent.type(message, "Apply the predefined reasoning level{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  expect(thread(app, "thread-replay-cursor")?.live?.options?.effort).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
  app.daemon.apply("thread-replay-cursor", [
    { type: "background.ended", task: "relay", status: "stopped" },
  ]);
  await waitFor(() =>
    expect(thread(app, "thread-replay-cursor")?.live?.options).toMatchObject({ effort: "medium" }),
  );
});

test("reset drops the effort picked for the next message, so it can steer again", async () => {
  const { message } = await open("busy");
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  expect(within(popover).queryByRole("button", { name: "Reset" })).toBeNull();
  await userEvent.click(within(popover).getByRole("button", { name: "High" }));
  const reset = within(popover).getByRole("button", { name: "Reset" });
  await userEvent.click(reset);
  expect(within(popover).getByRole("button", { name: "Medium" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await closeModelControl();
  expect(
    screen.getByRole("button", { name: "Model: Opus 5.5, Personal, Medium effort (default)" }),
  ).toBeTruthy();

  // A message carrying a new effort always waits for the next turn; without one, ⌘↵ steers.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  await userEvent.type(message, "Cap it at 500 instead{Meta>}{Enter}{/Meta}");
  expect(await within(feed).findByText("Cap it at 500 instead")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("a model without effort levels shows only model and account controls", async () => {
  await open("idle");
  // OpenCode's default model on this thread lists no effort levels.
  const popover = await openModelControl(/^Model: Muse Spark/);
  expect(within(popover).queryByText(/has no effort levels/)).toBeNull();
  expect(within(popover).queryByText("Default effort")).toBeNull();
  expect(within(popover).queryByRole("slider")).toBeNull();
});
test("while the agent works, Stop sits on the composer's tab and a draft offers Queue", async () => {
  const { message } = await open("busy");
  const agents = await screen.findByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.type(message, "Also check cold start");
  expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
  // Stop stays where it was, on the tab; the draft never turns the send button into it.
  expect(screen.getAllByRole("button", { name: "Stop the agent" })).toHaveLength(1);
  expect(within(agents).getByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("offline, the model chip keeps the thread's last-known model and says changes wait", async () => {
  const { app } = await open("busy");
  await screen.findByRole("button", { name: /^Model: Opus 5\.5, Personal/ });
  act(() => app.client.networkOnline(false));
  await screen.findByText(/^Offline/);
  const chip = screen.getByRole("button", { name: /^Model: Opus 5\.5/ });
  await userEvent.click(chip);
  expect(await screen.findByText("Offline: changes apply when reconnected")).toBeTruthy();
});

test("a switch queued to a provider with no catalog models keeps showing it across a reconnect", async () => {
  const { app } = await open("busy", ({ daemon }) => {
    daemon.services.models = daemon.services.models.filter((model) => model.provider !== "pi");
  });
  await screen.findByRole("button", { name: /^Model: Opus 5\.5, Personal/ });
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
  expect(await screen.findByRole("button", { name: /^Model: Unknown model/ })).toBeTruthy();

  act(() => app.client.networkOnline(false));
  await screen.findByText(/^Offline/);
  expect(screen.getByRole("button", { name: /^Model: Unknown model/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Model: Opus/ })).toBeNull();

  act(() => app.client.networkOnline(true));
  await waitFor(() => expect(screen.queryByText(/^Offline/)).toBeNull());
  expect(screen.getByRole("button", { name: /^Model: Unknown model/ })).toBeTruthy();
});

test("the chosen approval preset stays checked while its native change is pending", async () => {
  const { app } = await open("busy");
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Auto review" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Manual" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Approvals: Manual/ }));
  expect(
    (await screen.findByRole("menuitemradio", { name: "Manual" })).getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Auto review" }));
  await waitFor(() =>
    expect(thread(app, "thread-replay-cursor")?.permission?.override).toBe("auto"),
  );
});
