import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Keep as a test (ADR 0204 §1): a finished reply's More menu keeps the run as a test after a
 * review of what will be written; the bot's profile lists its kept runs, each with Delete.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const orders = spade.addAgent({ id: "orders", name: "Orders" });
  spade.store(orders.conversation, { type: "user_message", text: "Where is order ORD-55821?" });
  spade.store(orders.conversation, { type: "reply_started", reply: "r1" });
  spade.store(orders.conversation, {
    type: "tool_finished",
    reply: "r1",
    call_id: "c1",
    name: "lookup",
    content: "ORD-55821 ships Friday",
  });
  spade.store(orders.conversation, { type: "step_finished", reply: "r1", text: "It ships Friday." });
  spade.store(orders.conversation, { type: "reply_finished", reply: "r1", text: "It ships Friday." });
}

test("a finished reply is kept as a test after a review that hides what the person marks", async () => {
  const { spade } = await spadeApp("/spade/orders", seed);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Orders" }));
  const run = await chat.findByRole("article", { name: "Orders" });
  await userEvent.click(within(run).getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Keep as a test" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Keep as a test" }));
  const kept = within(dialog.getByRole("region", { name: "What it keeps" }));
  expect(await kept.findByText("Where is order ORD-55821?")).toBeTruthy();
  expect(kept.getByText("lookup")).toBeTruthy();
  expect(kept.getByText("It ships Friday.")).toBeTruthy();

  await userEvent.click(dialog.getByRole("radio", { name: "This was wrong" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Why" }), "Missed the date");
  await userEvent.type(dialog.getByRole("textbox", { name: "Something else to hide" }), "ORD-55821");
  await userEvent.click(dialog.getByRole("button", { name: "Hide" }));
  // The review reads again, the marked value hidden everywhere it showed.
  expect(await kept.findByText("Where is order •••?")).toBeTruthy();
  expect(kept.getByText("••• ships Friday")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Keep as a test" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keep as a test" })).toBeNull());

  const [stored] = spade.cases.kept.get("orders") ?? [];
  const body = JSON.stringify(stored);
  expect(body).not.toContain("ORD-55821");
  expect(stored?.summary).toMatchObject({ mark: "wrong", why: "Missed the date" });
});

test("the profile lists a bot's kept runs with Delete, and lists nothing once none are left", async () => {
  const { spade } = await spadeApp("/spade/orders?profile=details", (fake) => {
    seed(fake);
    fake.cases.add("orders", {
      reply: "r1",
      given: { messages: ["Where is order •••?"] },
      outcome: { text: "It ships Friday." },
      mark: "wrong",
      why: "Missed the date",
      trigger: { kind: "routine", name: "Morning check" },
      made_at: 1,
    });
  });
  const section = within(await screen.findByRole("region", { name: "Kept as tests" }));
  expect(section.getByText("Where is order •••?")).toBeTruthy();
  expect(
    section.getByText(/Marked wrong · Missed the date · From Morning check\s+Answered: It ships Friday\./),
  ).toBeTruthy();
  await userEvent.click(
    section.getByRole("button", { name: "Delete the test “Where is order •••?”" }),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Kept as tests" })).toBeNull());
  expect(spade.cases.kept.get("orders")).toEqual([]);
});

test("a reply still being written offers no Keep as a test", async () => {
  await spadeApp("/spade/orders", (fake) => {
    withEndpoint(fake);
    fake.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const orders = fake.addAgent({ id: "orders", name: "Orders" });
    fake.store(orders.conversation, { type: "user_message", text: "Where is it?" });
    fake.store(orders.conversation, { type: "reply_started", reply: "r1" });
    fake.store(orders.conversation, { type: "step_finished", reply: "r1", text: "Looking." });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Orders" }));
  const run = await chat.findByRole("article", { name: "Orders" });
  expect(await within(run).findByText("Looking.")).toBeTruthy();
  expect(within(run).queryByRole("button", { name: "More" })).toBeNull();
});
