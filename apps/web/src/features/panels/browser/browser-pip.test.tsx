import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openThreadBrowser } from "./views-test-support.tsx";

const togglePanel = () => userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
const pip = () => screen.queryByRole("region", { name: /^Picture in picture/ });

test("closing the panel while an agent browses keeps the page floating, and its title brings the panel back", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  act(() => browser.agentWorks(thread, { agentId: "worker" }));
  expect(pip()).toBeNull();
  await togglePanel();
  const floating = await screen.findByRole("region", { name: /^Picture in picture/ });
  // The live page, drawn from the screencast.
  expect(
    within(floating).getByRole("img", { name: "Live view of localhost:5173/settings/devices" }),
  ).toBeTruthy();
  await userEvent.click(within(floating).getByRole("button", { name: /^Show .* in the panel$/ }));
  await waitFor(() => expect(pip()).toBeNull());
  expect(within(panel).getByRole("img", { name: /^Live view of/ })).toBeTruthy();
});

test("a dismissed picture-in-picture stays away until the Browser shows again; a quiet page never floats", async () => {
  const { browser, thread } = await openThreadBrowser();
  act(() => browser.agentIdle(thread));
  await togglePanel();
  // Nobody browses and nothing plays: the page doesn't follow the person around.
  expect(pip()).toBeNull();
  // Sound starts: it floats.
  act(() => browser.mediaPlays(thread, true));
  const floating = await screen.findByRole("region", { name: /^Picture in picture/ });
  await userEvent.click(within(floating).getByRole("button", { name: "Close picture in picture" }));
  await waitFor(() => expect(pip()).toBeNull());
  act(() => browser.agentWorks(thread, { agentId: "worker" }));
  expect(pip()).toBeNull();
  // The Browser shows and hides again: picture-in-picture is back.
  await togglePanel();
  await screen.findByRole("region", { name: "Thread panel" });
  await togglePanel();
  expect(await screen.findByRole("region", { name: /^Picture in picture/ })).toBeTruthy();
});
