import { facts, longHistory, replayCursor } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

/*
 * The thread composer from the keyboard: the primary slot switches from Stop to a follow-up action, ↑
 * recalls the last message, ⌘Z / ⇧⌘Z walk the composer's own history, and the suggestion list
 * follows the arrows, Home, End and the pointer.
 */

async function open(scenario: "idle" | "busy") {
  const app = harness();
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else {
    app.play(replayCursor()).runThrough("finding");
    // The main agent is back at its own work, not only waiting on its subagents: follow-ups queue.
    app.daemon.apply("thread-replay-cursor", [facts.toolDone("root", "spawn-test")]);
  }
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, message };
}

test("typing replaces Stop with Queue and clearing the draft brings Stop back", async () => {
  const { message } = await open("busy");
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.type(message, "Also check cold start");
  expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  await userEvent.clear(message);
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("↑ in an empty idle composer brings back the last message sent, and ⌘Z puts it away", async () => {
  const { message } = await open("idle");
  await userEvent.click(message);
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => expect(message.textContent).toBe("Question 2: what does route 2 render?"));
  await userEvent.keyboard("{Meta>}z{/Meta}");
  await waitFor(() => expect(message.textContent).toBe(""));
  await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
  await waitFor(() => expect(message.textContent).toBe("Question 2: what does route 2 render?"));
});

test("↑ recalls nothing while the agent works or once something is typed", async () => {
  const { message } = await open("busy");
  await userEvent.click(message);
  await userEvent.keyboard("{ArrowUp}");
  expect(message.textContent).toBe("");
  await userEvent.type(message, "draft");
  await userEvent.keyboard("{ArrowUp}");
  expect(message.textContent).toBe("draft");
});

test("⌘Z takes typed text back and ⇧⌘Z brings it again", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "hello");
  await userEvent.keyboard("{Meta>}z{/Meta}");
  await waitFor(() => expect(message.textContent).toBe(""));
  await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
  await waitFor(() => expect(message.textContent).toBe("hello"));
});

test("Tab with a draft reaches +, access, the model and Queue in order", async () => {
  const { message } = await open("busy");
  await userEvent.type(message, "Follow up");
  const queue = screen.getByRole("button", { name: "Queue message" });
  const controls = [
    screen.getByRole("button", { name: "Add files and context" }),
    await screen.findByRole("button", { name: /^Access: / }),
    await screen.findByRole("button", { name: /^Model: / }),
    queue,
  ];
  await userEvent.click(message);
  const reached: Element[] = [];
  for (let press = 0; press < 12 && !reached.includes(queue); press++) {
    await userEvent.tab();
    if (document.activeElement) reached.push(document.activeElement);
  }
  const order = controls.map((control) => reached.indexOf(control));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
});

test("the command list follows Home, End and the pointer, and Esc closes it", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "/");
  const list = await screen.findByRole("listbox", { name: "Commands" });
  const options = within(list).getAllByRole("option");
  expect(options.length).toBeGreaterThan(2);
  const selected = () =>
    within(list)
      .getAllByRole("option")
      .findIndex((option) => option.getAttribute("aria-selected") === "true");
  expect(selected()).toBe(0);
  await userEvent.keyboard("{End}");
  expect(selected()).toBe(options.length - 1);
  await userEvent.keyboard("{Home}");
  expect(selected()).toBe(0);
  await userEvent.keyboard("{ArrowDown}");
  expect(selected()).toBe(1);
  const third = options[2];
  if (!third) throw new Error("Missing third command");
  fireEvent.mouseMove(third);
  expect(selected()).toBe(2);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  expect(message.textContent).toBe("/");
});
