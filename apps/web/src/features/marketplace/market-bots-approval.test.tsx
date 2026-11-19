import type { FakeDaemon } from "@ace/fake-daemon";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { findMarket, openApp } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

async function forBots(daemon: FakeDaemon) {
  const answer = await daemon.marketplace.handle({
    type: "marketplace.request",
    requestId: "bots",
    operation: { op: "spadeSkills" },
  });
  if (answer.type !== "marketplace.result" || answer.result.op !== "spadeSkills") return [];
  return answer.result.skills.map((skill) => skill.name);
}

test("a skill installed without the person waits as 'Installed · Turn on for your bots' until they turn it on", async () => {
  const app = await openApp("/chats?market=installed", {
    installed: [
      {
        source: "market",
        type: "spade-skill",
        name: "triage-mail",
        title: "Triage mail",
        version: "1.0.0",
        hash: "a".repeat(64),
        acceptedAt: 1,
        state: "on",
        botsApproved: false,
      },
    ],
  });
  const market = await findMarket();
  const rows = within(await within(market).findByRole("list", { name: "Installed" }));
  expect(rows.getByText(/Installed ·/)).toBeTruthy();
  expect(await forBots(app.daemon)).toEqual([]);

  await userEvent.click(rows.getByRole("button", { name: "Turn on for your bots" }));
  await waitFor(async () => expect(await forBots(app.daemon)).toEqual(["triage-mail"]));
  await waitFor(() =>
    expect(rows.queryByRole("button", { name: "Turn on for your bots" })).toBeNull(),
  );
});
