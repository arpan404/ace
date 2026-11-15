import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

/** A bot's page, from its row and its name in the header. */
async function openPage(name: string) {
  await userEvent.click(await botRow(name));
  await openProfile(name);
}

test("a refused step the bot tried again comes to the person with the reason, and Allow answers it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withSpade(api);
    const scout = api.addAgent({ id: "scout", name: "Scout" });
    api.escalate(
      scout,
      "k1",
      "call_tool",
      { tool: "book_flight" },
      "Refused again: It books a flight nobody asked for.",
    );
  });
  await userEvent.click(await botRow("Scout"));
  const request = within(
    await screen.findByRole("group", { name: "Scout wants to use book flight" }),
  );
  expect(request.getByText("Refused again: It books a flight nobody asked for.")).toBeTruthy();
  await userEvent.click(request.getByRole("button", { name: "Allow" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-scout/approvals/k1")).toEqual([
      { allowed: true, always: false },
    ]),
  );
  // It stays in the chat, answered: one line that says how.
  const answered = within(
    await screen.findByRole("group", { name: "Scout wants to use book flight. Allowed" }),
  );
  expect(answered.getByText("Allowed")).toBeTruthy();
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
        { kind: "access", name: "auto_review", summary: "access level" },
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
  // The log is on the profile's Computer tab.
  await userEvent.click(await screen.findByRole("tab", { name: "Computer" }));
  const list = within(await screen.findByRole("list", { name: "Activity" }));
  await waitFor(() =>
    expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Paused: its last 3 steps changed nothing\./),
      expect.stringMatching(/^Carried on by itself, step 4/),
      expect.stringMatching(/^Access changed to Auto-review/),
      expect.stringMatching(/^The reviewer refused: send an email.*Not its task\.$/),
      expect.stringMatching(/^The reviewer approved: read a web page.*Routine reading\.$/),
      expect.stringMatching(/^The reviewer asked you: send an email.*Sends as you\.$/),
    ]),
  );
});
