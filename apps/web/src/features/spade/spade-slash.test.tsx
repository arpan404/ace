import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/*
 * The `/` menu in Spade's composer: the screen's actions, the bot's skills and the commands of
 * its plugins; a skill or command picked leads the message as a chip and goes with the message.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function garden(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const bot = api.addAgent({ id: "garden", name: "Garden" });
  api.skillStore = {
    ace: true,
    skills: [
      {
        id: "skl_renderer",
        name: "renderer-perf-pass",
        description: "Profile the renderer, then fix the slowest frame first.",
        origin: "ace",
        text: "Profile the renderer first.",
      },
      {
        id: "sks_tidy",
        name: "tidy-commits",
        description: "Split a messy branch into small commits.",
        origin: "spade",
        text: "Split the branch.",
      },
      {
        id: "plg_review",
        name: "review-pr",
        description: "Review a pull request.",
        origin: "plugin",
        source: "release-kit",
        manual: true,
        text: "Review the pull request $ARGUMENTS.",
      },
    ],
  };
  return bot;
}

const field = () => screen.findByRole("combobox", { name: "Message Garden" });
const menu = async () => within(await screen.findByRole("listbox", { name: "Commands" }));
const rows = async () => (await menu()).getAllByRole("option").map((row) => row.dataset.group);

test("typing / offers actions, skills and commands, each with its source, and filters as you type", async () => {
  await spadeApp("/spade/garden", garden);
  await userEvent.type(await field(), "/");
  const list = await menu();
  expect(await rows()).toEqual(expect.arrayContaining(["Actions", "Skills", "Skills", "Commands"]));
  expect(
    list.getByRole("option", { name: /renderer-perf-pass.*Profile the renderer/ }),
  ).toBeTruthy();
  expect(list.getByRole("option", { name: /review-pr.*Review a pull request/ })).toBeTruthy();

  // Each row says where it comes from.
  expect(list.getByText("release-kit")).toBeTruthy();

  await userEvent.type(await field(), "rev");
  const filtered = await menu();
  expect(filtered.getAllByRole("option")).toHaveLength(1);
  expect(filtered.getByRole("option", { name: /review-pr/ })).toBeTruthy();
});

test("the arrows move, Esc closes, and Enter picks a skill as a chip leading the message", async () => {
  await spadeApp("/spade/garden", garden);
  const input = await field();
  await userEvent.type(input, "/til");
  // Esc closes the list and keeps the words.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  await userEvent.clear(input);
  await userEvent.type(input, "/");
  const options = (await menu()).getAllByRole("option");
  const first = options.findIndex((row) => row.getAttribute("aria-selected") === "true");
  await userEvent.keyboard("{ArrowDown}");
  const moved = (await menu())
    .getAllByRole("option")
    .findIndex((row) => row.getAttribute("aria-selected") === "true");
  expect(moved).toBe(first + 1);
  await userEvent.type(input, "renderer");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  expect(input.textContent).toContain("/renderer-perf-pass");
});

test("a picked command goes with its arguments, and shows as a chip in the person's bubble", async () => {
  let garden_: ReturnType<typeof garden> | undefined;
  const { spade } = await spadeApp("/spade/garden", (api) => {
    garden_ = garden(api);
  });
  const input = await field();
  await userEvent.type(input, "/review");
  await userEvent.keyboard("{Enter}");
  await userEvent.type(input, "#41");
  await userEvent.keyboard("{Enter}");
  const feed = within(await screen.findByRole("feed", { name: "Conversation with Garden" }));
  expect(await feed.findByText("/review-pr")).toBeTruthy();
  expect(feed.getByText("#41")).toBeTruthy();
  const stored = spade
    .eventsOf(garden_?.conversation ?? "")
    .find((event) => event.type === "user_message");
  expect(stored).toMatchObject({
    text: "#41",
    invoke: {
      kind: "command",
      id: "plg_review",
      name: "review-pr",
      args: "#41",
      text: "Review the pull request #41.",
    },
  });
});

test("an action in the menu runs where the screen already goes, and leaves no chip", async () => {
  const { app } = await spadeApp("/spade/garden", garden);
  const input = await field();
  await userEvent.type(input, "/model");
  await userEvent.keyboard("{Enter}");
  expect((await screen.findAllByText(/Models/i)).length).toBeGreaterThan(0);
  expect(app).toBeTruthy();
  expect(input.textContent).not.toContain("/model");
});
