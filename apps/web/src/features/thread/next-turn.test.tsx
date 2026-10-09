import { chooseAccount } from "@/test/model-control.ts";
import { replayCursor } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, type Command, type CommandPayload } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl } from "@/test/model-control.ts";

/*
 * Effort and speed picked in the model popover wait in the composer and go with the next
 * thread.send. These follow them through slow saves, refused switches and moves made on another
 * device, by what reaches the daemon.
 */

beforeEach(() => localStorage.clear());

const threadId = ThreadId.parse("thread-replay-cursor");
type Send = Extract<CommandPayload, { type: "thread.send" }>;

/** A Claude Code thread mid-turn, and every thread.send the daemon receives from now on. */
async function open(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  app.play(replayCursor()).runThrough("finding");
  const sent: Send[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command: Command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload);
    return receive(command);
  };
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, sent, message };
}

/** Move the reasoning choices with the keyboard, as a person tabbing to it would. */
async function effort(chip: RegExp, keys: string) {
  const popover = await openModelControl(chip);
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard(keys);
  await closeModelControl();
}

/** Another device moves the thread to another model. */
function switchElsewhere(app: ReturnType<typeof harness>, id: string, selection: object) {
  app.daemon.command({
    id: CommandId.parse(id),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "thread.switch", threadId, selection: { options: {}, ...selection } },
  } as Command);
}

test("effort picked while a message is still saving stays for the next message", async () => {
  // The client's outbox can hold one save, as a slow disk would.
  const store = memoryStorage();
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const outbox = {
    load: store.load,
    async save(value: string) {
      const wait = held;
      held = undefined;
      if (wait) await wait;
      return store.save(value);
    },
  };
  const { sent, message } = await open({ outbox });
  await effort(/^Model: Opus 5\.5/, "{End}");

  held = new Promise((resolve) => (release = resolve));
  await userEvent.type(message, "Cap the replay at 200{Enter}");
  // While it saves, the person picks Low for the message after.
  await effort(/^Model: Opus 5\.5, Personal, High effort/, "{Home}");
  release?.();

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.options).toMatchObject({ effort: "high" });
  expect(
    await screen.findByRole("button", { name: "Model: Opus 5.5, Personal, Low effort" }),
  ).toBeTruthy();
  await userEvent.type(message, "And log the cap{Enter}");
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]?.options).toMatchObject({ effort: "low" });
});

test("a switch the daemon refuses keeps the effort picked for the next message", async () => {
  const { app, sent, message } = await open();
  await effort(/^Model: Opus 5\.5/, "{End}");
  app.daemon.refuseCommands("instance_unavailable", "thread.switch");

  const popover = await openModelControl(/^Model: Opus 5\.5, Personal, High effort/);
  await chooseAccount(popover, "Work");
  expect(await screen.findByText("Couldn't switch the model")).toBeTruthy();
  await closeModelControl();
  expect(
    screen.getByRole("button", { name: "Model: Opus 5.5, Personal, High effort" }),
  ).toBeTruthy();

  await userEvent.type(message, "Cap the replay at 200{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.options).toMatchObject({ effort: "high" });
});

test("a switch that lands keeps the effort its model also takes", async () => {
  const { sent, message } = await open();
  await effort(/^Model: Opus 5\.5/, "{End}");
  const popover = await openModelControl(/^Model: Opus 5\.5, Personal, High effort/);
  await chooseAccount(popover, "Work");
  expect(
    await screen.findByRole("button", { name: "Model: Opus 5.5, Work, High effort" }),
  ).toBeTruthy();
  await closeModelControl();

  await userEvent.type(message, "Cap the replay at 200{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.options).toMatchObject({ effort: "high" });
});

test("a move to another provider from another device resets what its model can't take", async () => {
  const { app, sent, message } = await open();
  switchElsewhere(app, "to-codex", {
    provider: "codex",
    model: "gpt-5-codex",
    instanceId: "codex-personal",
  });
  await screen.findByRole("button", { name: /^Model: GPT-5 Codex, Personal/ });
  // Minimal effort and the fast tier: both Codex's own.
  const popover = await openModelControl(/^Model: GPT-5 Codex, Personal/);
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{Home}");
  await userEvent.click(within(popover).getByRole("button", { name: "Fast mode" }));
  await closeModelControl();
  expect(
    screen.getByRole("button", { name: "Model: GPT-5 Codex, Personal, Minimal effort, fast" }),
  ).toBeTruthy();

  switchElsewhere(app, "to-claude", {
    provider: "claude",
    model: "claude-opus-5-5",
    instanceId: "claude-personal",
  });
  expect(await screen.findByText("Effort and speed reset for Opus 5.5")).toBeTruthy();
  expect(
    await screen.findByRole("button", {
      name: "Model: Opus 5.5, Personal, provider default effort",
    }),
  ).toBeTruthy();

  await userEvent.type(message, "Cap the replay at 200{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.options).toBeUndefined();
});
