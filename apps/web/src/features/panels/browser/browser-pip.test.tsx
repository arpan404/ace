import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";
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

test("with picture in picture turned off in Settings › Browser, leaving the Browser never floats the page", async () => {
  const scenario = coldStartReplay();
  const history = createMemoryHistory({ initialEntries: ["/settings/browser"] });
  browserVideo();
  const app = harness({ history });
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open("/settings/browser");
  const setting = await screen.findByRole("switch", { name: "Picture in picture" });
  expect(setting.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(setting);
  await waitFor(() => expect(setting.getAttribute("aria-checked")).toBe("false"));

  act(() => void history.push("/t/thread-cold-start"));
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await togglePanel();
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: "Live view of localhost:5173/settings/devices" });
  const thread = "thread-cold-start";
  act(() => {
    app.daemon.browser.agentWorks(thread, { agentId: "worker" });
    app.daemon.browser.mediaPlays(thread, true);
  });
  await togglePanel();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(pip()).toBeNull();
});
