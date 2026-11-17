import { marketPickFixture, marketPublishFixture, type FakeDaemon } from "@ace/fake-daemon";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { findMarket, openApp } from "./market-test-seed.ts";

/*
 * The publish flow's picker (ADR 0174 §2): the person's own bots, skills and plugins, and what
 * publishing one would upload, which they see and confirm before anything leaves the machine.
 */

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const typeButton = {
  bot: /A recipe: face, task, routines/,
  skill: /Instructions and scripts a bot can use/,
  plugin: /Commands and tools for agents and bots/,
};

const lastSent = (daemon: FakeDaemon) => daemon.marketplace.publishing.sources.at(-1);
const nextButton = (market: HTMLElement) => within(market).getByRole("button", { name: "Next" });

async function pickFrom(type: keyof typeof typeButton, pick: RegExp, seed = marketPickFixture()) {
  const { daemon } = await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: seed,
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton[type] }));
  const yours = within(await within(market).findByRole("group", { name: "Yours" }));
  await userEvent.click(yours.getByRole("button", { name: pick }));
  return { daemon, market };
}

test.each([
  {
    type: "skill" as const,
    pick: /Triage mail/,
    sent: {
      type: "spade-skill",
      name: "triage-mail",
      source: { kind: "ace-skill", id: `skl_${"a".repeat(40)}` },
    },
  },
  {
    type: "plugin" as const,
    pick: /mail-tools/,
    sent: {
      type: "spade-plugin",
      name: "mail-tools",
      source: { kind: "plugin", name: "mail-tools" },
    },
  },
])("a $type is picked from your own, and its draft names what was picked", async (each) => {
  const { daemon, market } = await pickFrom(each.type, each.pick);
  const upload = within(await within(market).findByRole("list", { name: "What will upload" }));
  expect(upload.getByText("SKILL.md")).toBeTruthy();
  await waitFor(() => expect(nextButton(market).hasAttribute("disabled")).toBe(false));
  await userEvent.click(nextButton(market));

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSent(daemon)).toMatchObject(each.sent);
  expect(lastSent(daemon)?.checked).toMatchObject({ binaries: [], accepted: [] });
});

test("a bot's task waits for the person, its routines start left out, and only its id is sent", async () => {
  const { daemon, market } = await pickFrom("bot", /Inbox sorter/);
  const recipe = within(await within(market).findByRole("region", { name: "Its recipe" }));
  // The task's flagged text is shown, and Next waits for the person to confirm the task.
  expect(await recipe.findByText(/"Arlo Quint" is your name/)).toBeTruthy();
  expect(nextButton(market).hasAttribute("disabled")).toBe(true);
  const routines = within(recipe.getByRole("list", { name: "Routines" }));
  const sort = routines.getByRole("checkbox", { name: "Include Morning sort" });
  const receipts = routines.getByRole("checkbox", { name: "Include File receipts" });
  expect((sort as HTMLInputElement).checked).toBe(false);
  expect((receipts as HTMLInputElement).checked).toBe(false);
  expect(recipe.getByText("gmail")).toBeTruthy();
  expect(recipe.getByText(/a custom app you added/)).toBeTruthy();

  await userEvent.click(recipe.getByRole("checkbox", { name: "The task is ready to publish" }));
  await waitFor(() => expect(nextButton(market).hasAttribute("disabled")).toBe(false));
  await userEvent.click(nextButton(market));

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  const sent = lastSent(daemon);
  expect(sent?.source).toEqual({ kind: "spade-bot", id: "a_inbox" });
  expect(sent?.checked?.recipe).toEqual({
    task: "You look after Arlo Quint's inbox.",
    routines: [],
  });
  expect(sent?.checked?.accepted).toEqual(["Arlo Quint"]);
});

test("an included routine must be confirmed, and an edit clears what it took out", async () => {
  const { daemon, market } = await pickFrom("bot", /Inbox sorter/);
  const recipe = within(await within(market).findByRole("region", { name: "Its recipe" }));
  const task = await recipe.findByRole("textbox", { name: "Task" });
  await userEvent.clear(task);
  await userEvent.type(task, "You look after the inbox.");
  await waitFor(() => expect(recipe.queryByText(/"Arlo Quint" is your name/)).toBeNull());
  await userEvent.click(recipe.getByRole("checkbox", { name: "The task is ready to publish" }));

  await userEvent.click(recipe.getByRole("checkbox", { name: "Include File receipts" }));
  expect(
    await recipe.findByText(/"\/Users\/arloq\/Receipts" is a folder on your computer/),
  ).toBeTruthy();
  expect(nextButton(market).hasAttribute("disabled")).toBe(true);
  // Editing the task after confirming asks for it again.
  await userEvent.type(task, " Daily.");
  expect(
    (recipe.getByRole("checkbox", { name: "The task is ready to publish" }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  await userEvent.click(recipe.getByRole("checkbox", { name: "The task is ready to publish" }));
  await userEvent.click(
    recipe.getByRole("checkbox", { name: "File receipts is ready to publish" }),
  );
  await waitFor(() => expect(nextButton(market).hasAttribute("disabled")).toBe(false));
  await userEvent.click(nextButton(market));

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSent(daemon)?.checked).toMatchObject({
    recipe: {
      task: "You look after the inbox. Daily.",
      routines: [
        {
          name: "File receipts",
          instruction: "Save receipts to /Users/arloq/Receipts.",
          schedule: "daily at 18:00",
        },
      ],
    },
    accepted: ["/Users/arloq/Receipts"],
  });
});

const skillSource = JSON.stringify({ kind: "ace-skill", id: `skl_${"a".repeat(40)}` });

test("a folder's check shows every file, what stayed home, and binaries only when ticked", async () => {
  const seed = marketPickFixture();
  seed.checks = {
    [skillSource]: {
      files: [
        { path: "SKILL.md", bytes: 120, binary: false },
        { path: "logo.png", bytes: 2048, binary: true },
        { path: "notes.md", bytes: 64, binary: false },
      ],
      excluded: [
        { path: ".env", reason: "hidden" },
        { path: "deploy.pem", reason: "credential" },
      ],
      findings: [
        {
          path: "notes.md",
          line: 2,
          kind: "email",
          text: "boss@example.com",
          sentence: '"boss@example.com" is an email address.',
          blocking: false,
        },
      ],
    },
  };
  const { daemon, market } = await pickFrom("skill", /Triage mail/, seed);
  const upload = within(await within(market).findByRole("list", { name: "What will upload" }));
  expect(upload.getByText("notes.md")).toBeTruthy();
  const left = within(within(market).getByRole("list", { name: "Left out" }));
  expect(left.getByText(".env")).toBeTruthy();
  expect(left.getByText("deploy.pem")).toBeTruthy();
  expect(within(market).getByText(/"boss@example.com" is an email address/)).toBeTruthy();
  expect(nextButton(market).hasAttribute("disabled")).toBe(true);

  await userEvent.click(upload.getByRole("checkbox", { name: "Include logo.png" }));
  await userEvent.click(within(market).getByRole("checkbox", { name: "These can be public" }));
  await waitFor(() => expect(nextButton(market).hasAttribute("disabled")).toBe(false));
  await userEvent.click(nextButton(market));
  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSent(daemon)?.checked).toMatchObject({
    binaries: ["logo.png"],
    accepted: ["boss@example.com"],
  });
});

test("a finding that blocks holds Next, with what to fix", async () => {
  const seed = marketPickFixture();
  seed.checks = {
    [skillSource]: {
      files: [{ path: "SKILL.md", bytes: 120, binary: false }],
      excluded: [],
      findings: [
        {
          path: "SKILL.md",
          line: 6,
          kind: "secret",
          text: "",
          sentence:
            "SKILL.md: Line 6 holds what looks like a GitHub token. Take it out before publishing.",
          blocking: true,
        },
      ],
    },
  };
  const { market } = await pickFrom("skill", /Triage mail/, seed);
  expect(
    await within(market).findByText(/Line 6 holds what looks like a GitHub token/),
  ).toBeTruthy();
  expect(within(market).queryByRole("checkbox", { name: "These can be public" })).toBeNull();
  expect(nextButton(market).hasAttribute("disabled")).toBe(true);
});

test("a bot whose recipe Spade refuses holds Next and says why", async () => {
  const seed = marketPickFixture();
  seed.recipes = {};
  const { market } = await pickFrom("bot", /Inbox sorter/, seed);
  expect(await within(market).findByText("no such agent")).toBeTruthy();
  expect(nextButton(market).hasAttribute("disabled")).toBe(true);
});

test("Choose a folder… still publishes a folder by path, once its check is seen", async () => {
  const { daemon } = await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: marketPickFixture(),
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.skill }));
  await within(market).findByRole("group", { name: "Yours" });
  await userEvent.click(within(market).getByRole("button", { name: "Choose a folder…" }));
  await userEvent.type(within(market).getByLabelText("Name in the marketplace"), "sort-receipts");
  await userEvent.type(within(market).getByLabelText("Folder on this machine"), "/Users/me/sort");
  await within(market).findByRole("list", { name: "What will upload" });
  await waitFor(() => expect(nextButton(market).hasAttribute("disabled")).toBe(false));
  await userEvent.click(nextButton(market));

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSent(daemon)).toMatchObject({
    type: "spade-skill",
    name: "sort-receipts",
    source: { kind: "folder", path: "/Users/me/sort" },
  });
});

test("an empty list says so, and a place that can't be read says why", async () => {
  await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: {
      items: [],
      unavailable: { "spade-bot": ["Spade's bots can't be listed: Spade isn't running."] },
    },
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.bot }));
  expect(
    await within(market).findByText("Spade's bots can't be listed: Spade isn't running."),
  ).toBeTruthy();
  expect(within(market).getByText("You don't have a bot in Spade yet.")).toBeTruthy();
});
