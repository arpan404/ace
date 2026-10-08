import { workbenchServices } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const worker = "mobile-cold-start.hermes-bytecode.thread";

test("a deck's thread lists its deck's lanes in Agents, and a lane opens as a tab beside it", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(`/t/${worker}`);
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });

  const lanes = await within(panel).findByRole("list", {
    name: "Lanes of Mobile cold start under 1s",
  });
  const own = within(lanes).getByRole("button", { name: /Precompile Hermes bytecode/ });
  expect(own.textContent).toContain("this thread");
  expect(within(lanes).getByRole("button", { name: /Defer the first relay sync/ })).toBeTruthy();

  await userEvent.click(own);
  expect(
    within(panel).getByRole("tab", { name: "Precompile Hermes bytecode", selected: true }),
  ).toBeTruthy();
  const lane = await within(panel).findByRole("region", {
    name: "Lane: Precompile Hermes bytecode",
  });
  expect(within(lane).getAllByText("Worker").length).toBeGreaterThan(0);
  expect(
    within(panel)
      .getByRole("link", { name: /Open offshift/ })
      .getAttribute("href"),
  ).toContain("/offshifts/mobile-cold-start");
});

test("a lane on the Deck view opens beside its thread", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/offshifts/mobile-cold-start?card=card-2");
  const lane = await screen.findByRole("region", { name: /^Lane: / });
  const title = (lane.getAttribute("aria-label") ?? "").replace("Lane: ", "");
  await userEvent.click(await within(lane).findByRole("button", { name: "Open beside thread" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: title, selected: true })).toBeTruthy();
  expect(await within(panel).findByRole("region", { name: `Lane: ${title}` })).toBeTruthy();
});
