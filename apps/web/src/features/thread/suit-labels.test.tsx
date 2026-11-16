import { facts, longHistory, replayCursor } from "@ace/fake-daemon";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    document.documentElement.removeAttribute(name);
});

const worded = fakeSuit({
  id: "worded",
  dark: { canvas: "#101014" },
  labels: {
    "composer-placeholder": "Transmit to the grid",
    "working-word": "Jacking in",
    send: "Fire",
  },
});

async function open(scenario: "idle" | "busy") {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "worded" }));
  const app = harness({ storage, suits: fakeSuitLibrary([worded]).transport });
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else {
    app.play(replayCursor()).runThrough("finding");
    app.daemon.apply("thread-replay-cursor", [facts.toolDone("root", "spawn-test")]);
  }
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  await waitFor(() => expect(document.documentElement.getAttribute("data-suit")).toBe("worded"));
  return screen.findByRole("combobox", { name: "Message" });
}

test("a Suit's labels word the composer's placeholder and its Send", async () => {
  const message = await open("idle");
  await waitFor(() =>
    expect(message.getAttribute("aria-placeholder")).toBe("Transmit to the grid"),
  );
  await userEvent.type(message, "Ship it");
  expect(await screen.findByRole("button", { name: "Fire" })).toBeTruthy();
});

test("the Working line takes the Suit's word, and Queue keeps ace's while the agent works", async () => {
  const message = await open("busy");
  const line = await screen.findByRole("status", { name: /^Jacking in/ });
  expect(line.textContent).toMatch(/^Jacking in/);
  await userEvent.type(message, "And then");
  expect(await screen.findByRole("button", { name: "Queue message" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Fire" })).toBeNull();
});
