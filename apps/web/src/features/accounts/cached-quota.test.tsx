import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { WindowBar } from "./window-bar.tsx";

const observedAt = Date.parse("2026-10-06T21:44:30Z");
const now = Date.parse("2026-10-09T12:00:00Z");
test("an expired cached five-hour window never presents its old percentage as current usage", () => {
  render(
    <WindowBar
      window={{
        id: "five_hour",
        label: "5-hour",
        usedPercent: 5,
        resetsAt: Date.parse("2026-10-07T01:00:00Z"),
      }}
      now={now}
    />,
  );
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText("5%")).toBeNull();
  expect(screen.queryByText("0%")).toBeNull();
  expect(screen.queryByText("Resets now")).toBeNull();
  expect(screen.getByText("Waiting for a new provider reading")).toBeTruthy();
});
test("cached usage exposes its provider timestamp and Refresh cannot make an expired reading fresh", async () => {
  const app = harness();
  const account = app.daemon.services.accounts.find((entry) => entry.id === "claude-personal");
  if (!account) throw new Error("Missing account");
  account.quota.observedAt = observedAt;
  account.quota.windows = {
    five_hour: { usedPercent: 5, resetsAt: Date.parse("2026-10-07T01:00:00Z") },
    seven_day: { usedPercent: 73, resetsAt: Date.parse("2099-10-13T12:00:00Z") },
  };
  await app.open("/accounts");
  const card = await screen.findByRole("article", { name: "Claude Code Personal" });
  expect(within(card).queryByRole("meter", { name: "5-hour window" })).toBeNull();
  expect(
    within(card).getByRole("meter", { name: "Weekly window" }).getAttribute("aria-valuenow"),
  ).toBe("73");
  expect(card.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(observedAt).toISOString(),
  );
  expect(within(card).getByText(/Last provider reading/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(within(card).getByText("Waiting for a new provider reading")).toBeTruthy(),
  );
  expect(within(card).queryByRole("meter", { name: "5-hour window" })).toBeNull();
  const fresh = Date.now();
  app.daemon.services.updateQuota(account.id, {
    ...account.quota,
    observedAt: fresh,
    windows: { five_hour: { usedPercent: 8, resetsAt: fresh + 3600000 } },
  });
  await waitFor(() =>
    expect(
      within(card).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
    ).toBe("8"),
  );
  expect(card.querySelector("time")?.getAttribute("datetime")).toBe(new Date(fresh).toISOString());
});
