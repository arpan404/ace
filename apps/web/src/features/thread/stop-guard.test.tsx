import { replayCursor } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";
import { resetStops } from "./composer/stop-state.ts";

beforeEach(() => {
  resetDismissed();
  resetSendStore();
  resetStops();
});

/** The replay-cursor thread mid-turn: its root works with subagents and a background relay. */
async function working() {
  const made = harness();
  made.play(replayCursor()).runThrough("finding");
  const sent: CommandPayload[] = [];
  const receive = made.daemon.command.bind(made.daemon);
  made.daemon.command = (command) => {
    sent.push(command.payload);
    return receive(command);
  };
  await made.open("/t/thread-replay-cursor");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await screen.findByRole("button", { name: "Stop the agent" });
  await userEvent.click(message);
  const of = (type: CommandPayload["type"]) => sent.filter((payload) => payload.type === type);
  return { made, of };
}

const strip = () => document.querySelector("[data-composer-strip]")?.textContent ?? "";

test("one Esc while the agent works only asks in the strip; a second one soon stops the tree", async () => {
  const { of } = await working();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(strip()).toMatch(/^Esc again to stop · \d+ subagents?$/));
  expect(of("thread.interrupt")).toEqual([]);

  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(of("thread.interrupt")).toEqual([expect.objectContaining({ cascade: true })]),
  );
});

test("an Esc after the moment has passed asks again instead of stopping", async () => {
  const { of } = await working();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(strip()).toMatch(/^Esc again to stop/));
  await waitFor(() => expect(strip()).not.toMatch(/^Esc again to stop/), { timeout: 3000 });

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(strip()).toMatch(/^Esc again to stop/));
  expect(of("thread.interrupt")).toEqual([]);
});

test("after Stop, a command still running is said in the strip with Stop it, and nothing says Working", async () => {
  const { of } = await working();
  await userEvent.keyboard("{Escape}{Escape}");
  await waitFor(() => expect(strip()).toMatch(/^Stopped · 1 background command still running/));
  expect(screen.queryByRole("group", { name: "Turn in progress" })).toBeNull();
  expect(screen.queryByText(/Working for/)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Stop it" }));
  await waitFor(() => expect(of("background_task.stop")).toHaveLength(1));
  await waitFor(() => expect(strip()).not.toMatch(/^Stopped/));
});
