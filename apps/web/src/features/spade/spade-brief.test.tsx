import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("the morning brief in Spade's chat says what finished and answers a waiting approval in one tap", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const scout = api.addAgent({ id: "scout", name: "Scout" });
    api.escalate(scout, "k1", "call_tool", { tool: "deploy" }, "It deploys to production.");
    api.wakes.digests.push({
      id: 9,
      agent: "main",
      kind: "brief",
      made_ms: Date.now(),
      text: "Since 21:00: …",
      digest: {
        finished: [
          {
            agent: "scout",
            name: "Scout",
            conversation: "c-scout",
            seq: 4,
            text: "Release build finished after 2h.",
          },
        ],
        waiting: [
          {
            agent: "scout",
            name: "Scout",
            conversation: "c-scout",
            kind: "approval",
            call_id: "k1",
            what: "Wants your yes to use deploy.",
            answer: "approval",
          },
        ],
        today: [],
        spend: { total_micros: 2_100_000, bots: [{ name: "Scout", micros: 2_100_000 }] },
      },
    });
  });
  await userEvent.click(await botRow("Spade"));
  const brief = within(await screen.findByRole("article", { name: "Morning brief" }));
  expect(
    within(brief.getByRole("list", { name: "Finished" })).getByText(/Release build finished/),
  ).toBeTruthy();
  expect(brief.getByText("Spent $2.10 (Scout $2.10).")).toBeTruthy();
  await userEvent.click(brief.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-scout/approvals/k1")).toEqual([
      { allowed: true, always: false },
    ]),
  );
  expect(await brief.findByText("Answered: Allow once")).toBeTruthy();
});
