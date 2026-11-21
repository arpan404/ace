import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/*
 * An update review replays the bot's kept runs on the new version (ADR 0204 §2): free as it
 * opens, in one sentence with See why for the runs that differ, and on the bot's own model only
 * when the person presses Try it, its cost said first.
 */

const offered = { source: "spade", name: "inbox", version: "1.0.0", hash: "b".repeat(64) };
const recipe = { format: "spade-bot", version: 3, name: "Inbox", task: "Sort my mail." };

function templateBot(fake: FakeSpadeApi) {
  withEndpoint(fake);
  fake.addAgent({
    id: "inbox",
    name: "My inbox",
    package: {
      source: "spade",
      name: "inbox",
      version: "0.9.0",
      hash: "a".repeat(64),
      template_update: { version: "1.0.0" },
      effects: [],
    },
    templateOffer: {
      package: offered,
      recipe,
      plan: {
        name: "same",
        task: "replace",
        face: "same",
        personality: "same",
        routines: [],
        notes_kept: 0,
        asks_more: [],
        off: [],
      },
      effects: [],
    },
  });
  fake.cases.add("inbox", {
    id: "case_sorted",
    reply: "r1",
    given: { messages: ["Sort this morning's mail."] },
    outcome: { text: "Sorted 12 mails." },
    mark: "right",
  });
  fake.cases.add("inbox", {
    id: "case_replied",
    reply: "r2",
    given: { messages: ["Answer the landlord."] },
    outcome: { text: "Drafted a reply." },
  });
  fake.cases.differs.set(
    "case_replied",
    "send_message was refused: Inbox doesn't declare sending.",
  );
}

test("an update review replays the kept runs free and says which differ, and why", async () => {
  const { spade } = await spadeApp("/spade/inbox?profile=details", templateBot);
  await userEvent.click(await screen.findByRole("button", { name: "Update to 1.0.0" }));
  const review = within(await screen.findByRole("dialog"));
  expect(
    await review.findByText("1 of 2 kept runs replay the same. 1 doesn't: see why."),
  ).toBeTruthy();
  expect(review.queryByRole("list", { name: "Kept runs that differ" })).toBeNull();
  await userEvent.click(review.getByRole("button", { name: "See why" }));
  const differ = review.getByRole("list", { name: "Kept runs that differ" });
  expect(differ.textContent).toBe(
    "Answer the landlord.: send_message was refused: Inbox doesn't declare sending.",
  );
  // It replayed the version on offer, on the recorded steps: no model named, nothing spent.
  expect(spade.cases.replays).toEqual([{ agent: "inbox", body: { recipe } }]);
});

test("a replay on the bot's own model runs only when the person presses Try it, its cost said first", async () => {
  const { spade } = await spadeApp("/spade/inbox?profile=details", templateBot);
  await userEvent.click(await screen.findByRole("button", { name: "Update to 1.0.0" }));
  const review = within(await screen.findByRole("dialog"));
  expect(
    await review.findByText("Try it on your last 2 kept runs: under $0.01 on GPT-6.1 mini."),
  ).toBeTruthy();
  expect(spade.cases.replays).toHaveLength(1);
  await userEvent.click(review.getByRole("button", { name: "Try it" }));
  expect(
    await review.findByText("1 of 2 kept runs the same or better. 1 worse: see why."),
  ).toBeTruthy();
  await waitFor(() =>
    expect(spade.cases.replays.at(-1)).toEqual({
      agent: "inbox",
      body: { recipe, model: "current" },
    }),
  );
  // Nothing moved while the person read and tried it.
  expect(spade.agents.find((agent) => agent.id === "inbox")?.package?.["version"]).toBe("0.9.0");
});
