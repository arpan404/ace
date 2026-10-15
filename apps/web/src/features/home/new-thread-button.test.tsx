import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { longHistory } from "@ace/fake-daemon";

test("the sidebar New thread button opens a fresh composer on the first click", async () => {
  const made = harness();
  made.play(longHistory(2)).runUntilBlocked();
  await made.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });

  await userEvent.click(await screen.findByRole("link", { name: "New thread" }));

  expect(await screen.findByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
}, 15000);
