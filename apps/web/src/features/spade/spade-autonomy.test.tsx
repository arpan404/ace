import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

/** A bot's page, from its row and its name in the header. */
async function openPage(name: string) {
  await userEvent.click(await botRow(name));
  await userEvent.click(
    await screen.findByRole("link", { name: new RegExp(`^${name} on .*open its page$`) }),
  );
  return within(await screen.findByRole("region", { name: "Access" }));
}

test("New bot starts on Auto-review and sends it with the bot", async () => {
  const { spade } = await spadeApp("/spade", withSpade);
  await openNew("New bot");
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  const access = within(form.getByRole("radiogroup", { name: "Access" }));
  expect(access.getByRole("radio", { name: "Auto-review" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Travel");
  await userEvent.click(form.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await userEvent.click(form.getByRole("button", { name: "Create bot" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ name: "Travel", access: "auto_review" }),
    ]),
  );
});

test("Full access is given only once the person confirms it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withSpade(api);
    api.addAgent({ id: "scout", name: "Scout", access: "auto_review" });
  });
  const access = await openPage("Scout");
  await userEvent.click(access.getByRole("radio", { name: "Full access" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Give Scout full access?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(spade.sent("PATCH", "/v1/agents/scout")).toEqual([]);
  expect(access.getByRole("radio", { name: "Auto-review" }).getAttribute("aria-checked")).toBe(
    "true",
  );

  await userEvent.click(access.getByRole("radio", { name: "Full access" }));
  await userEvent.click(await screen.findByRole("button", { name: "Give full access" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/scout")).toEqual([{ access: "full_access" }]),
  );
  // Back from Ask needs no confirmation.
  await userEvent.click(access.getByRole("radio", { name: "Ask" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/scout")).toEqual([
      { access: "full_access" },
      { access: "ask" },
    ]),
  );
});

test("a request the reviewer escalated shows its reason, and Allow answers it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withSpade(api);
    const scout = api.addAgent({ id: "scout", name: "Scout", access: "auto_review" });
    api.escalate(
      scout,
      "k1",
      "call_tool",
      { tool: "book_flight" },
      "It could spend money, so you decide.",
    );
  });
  await userEvent.click(await botRow("Scout"));
  const request = within(await screen.findByRole("group", { name: /^Scout wants to/ }));
  expect(request.getByText("It could spend money, so you decide.")).toBeTruthy();
  // Nothing of the review is in the conversation itself.
  expect(within(screen.getByRole("feed")).queryByText(/spend money/)).toBeNull();
  await userEvent.click(request.getByRole("button", { name: "Allow" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-scout/approvals/k1")).toEqual([
      { allowed: true, always: false },
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("group", { name: /^Scout wants to/ })).toBeNull());
});

test("the activity log lists the reviewer's verdicts with their reasons, and how the task went on", async () => {
  await spadeApp("/spade", (api) => {
    withSpade(api);
    api.addAgent({ id: "scout", name: "Scout" });
    const at = Date.now();
    api.oversight.activity.set(
      "scout",
      [
        { kind: "task", name: "paused", summary: "Paused: its last 3 steps changed nothing." },
        { kind: "task", name: "continued", summary: "carried on by itself, step 4" },
        { kind: "access", name: "full_access", summary: "access level" },
        { kind: "review", name: "send_email", outcome: "refused", reason: "Not its task." },
        { kind: "review", name: "web_fetch", outcome: "allowed", reason: "Routine reading." },
        { kind: "review", name: "send_email", outcome: "escalated", reason: "Sends as you." },
      ].map((fields, index) =>
        Object.assign(
          { id: `e${index}`, seq: 10 - index, at: at - index * 60_000, reply: null },
          { cost_micros: null, summary: "" },
          fields,
        ),
      ),
    );
  });
  await openPage("Scout");
  const section = within(await screen.findByRole("region", { name: "Activity" }));
  await userEvent.click(section.getByRole("button", { name: "All" }));
  const list = within(await screen.findByRole("list", { name: "Activity" }));
  await waitFor(() =>
    expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Paused: its last 3 steps changed nothing\./),
      expect.stringMatching(/Kept going: carried on by itself, step 4/),
      expect.stringMatching(/Access changed to Full access$/),
      expect.stringMatching(/The reviewer refused: send an emailNot its task\./),
      expect.stringMatching(/The reviewer approved: read a web pageRoutine reading\./),
      expect.stringMatching(/The reviewer asked you: send an emailSends as you\./),
    ]),
  );
});
