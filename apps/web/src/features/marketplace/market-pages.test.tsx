import { marketPublishFixture } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { cardForm } from "./market-card.tsx";
import { entry, findMarket, openApp } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

test.each([
  ["bots without pictures", [entry("spade-bot", "inbox", "Inbox")], "lockup"],
  [
    "skills and plugins without pictures",
    [entry("spade-skill", "triage", "Triage"), entry("spade-plugin", "tools", "Tools")],
    "lockup",
  ],
  [
    "a shelf where only some have pictures",
    [
      entry("spade-bot", "inbox", "Inbox", { previews: ["a".repeat(64)] }),
      entry("spade-bot", "notes", "Notes"),
    ],
    "lockup",
  ],
  [
    "Suits beside a bot without a picture",
    [entry("suit", "dusk", "Dusk"), entry("spade-bot", "inbox", "Inbox")],
    "lockup",
  ],
  ["Suits, which draw their window", [entry("suit", "dusk", "Dusk")], "stage"],
  [
    "entries that all have pictures",
    [entry("spade-bot", "inbox", "Inbox", { previews: ["a".repeat(64)] })],
    "stage",
  ],
] as const)("%s are drawn as %s cards", (_, entries, form) => {
  expect(cardForm(entries)).toBe(form);
});

test("an entry page says its one line once when the description only repeats it", async () => {
  await openApp("/chats?market=skill/triage-mail");
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: "Triage mail" });

  expect(within(market).getAllByText("Triage mail in one line")).toHaveLength(1);
});

test("an entry page shows its description when it says more than the line", async () => {
  await openApp("/chats?market=skill/triage-mail", {
    entries: [
      {
        summary: entry("spade-skill", "triage-mail", "Triage mail"),
        description: "Reads each new message and files it under what it needs from you.",
      },
    ],
  });
  const market = await findMarket();

  expect(
    await within(market).findByText(
      "Reads each new message and files it under what it needs from you.",
    ),
  ).toBeTruthy();
  expect(within(market).getByText("Triage mail in one line")).toBeTruthy();
});

test("Remove takes a link off the publisher's profile", async () => {
  await openApp("/chats?market=me", { publishing: marketPublishFixture() });
  const market = await findMarket();
  expect(await within(market).findByRole("link", { name: "Site" })).toBeTruthy();

  await userEvent.click(within(market).getByRole("button", { name: "Edit profile" }));
  await userEvent.click(await within(market).findByRole("button", { name: "Remove link 1" }));
  await userEvent.click(within(market).getByRole("button", { name: "Save" }));

  await within(market).findByRole("button", { name: "Edit profile" });
  await waitFor(() => expect(within(market).queryByRole("link", { name: "Site" })).toBeNull());
  expect(screen.getByRole("region", { name: "Marketplace" })).toBeTruthy();
});
