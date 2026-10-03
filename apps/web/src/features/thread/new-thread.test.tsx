import { longHistory, replayCursor } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("sending from New thread creates the thread in the chosen project and opens it", async () => {
  const app = harness();
  app.play(longHistory(1)).runUntilBlocked();
  app.play(replayCursor()).runThrough("asked");
  await app.open("/new");

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "acme-web" }));
  expect(screen.getByRole("button", { name: "Project: acme-web" })).toBeTruthy();

  const message = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Add a dark mode toggle to the settings page{Enter}");

  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "Add a dark mode toggle to the settings page",
    }),
  ).toBeTruthy();
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).getByText("Add a dark mode toggle to the settings page")).toBeTruthy();
});
