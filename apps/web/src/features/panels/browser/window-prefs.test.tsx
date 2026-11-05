import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";
import { extensionsHidden } from "./extensions-menu.tsx";
import { inputLatency } from "./use-local-echo.ts";

const threadId = "thread-cold-start";

afterEach(() => {
  extensionsHidden.set(() => false);
  inputLatency.set(() => new Map());
});

/** The cold-start thread with an agent's page in the Browser tool beside it. */
async function openBrowser(app = harness()) {
  browserVideo();
  app.play(coldStartReplay()).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("button", { name: "Browser options" }, { timeout: 10000 });
  return { app, panel };
}

async function options(panel: HTMLElement) {
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  return screen.findByRole("menu");
}

async function settingsSwitch(name: string) {
  const window = within(
    (await screen.findByText("In this window")).closest("section") ?? document.body,
  );
  return window.getByRole("switch", { name });
}

test("the device toolbar menu acts on this tab only; new tabs follow Settings › Browser", async () => {
  const { panel } = await openBrowser();
  await options(panel);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Device toolbar" }));
  expect(await screen.findByRole("menuitemcheckbox", { name: "Show device toolbar" })).toBeTruthy();
  expect(screen.queryByRole("menuitemcheckbox", { name: "Always show in new tabs" })).toBeNull();
});

test("the input round trip shows in the ⋯ menu only once Show connection stats is on", async () => {
  const app = harness();
  const { panel } = await openBrowser(app);
  act(() => inputLatency.set(() => new Map([[threadId, 42]])));
  let menu = await options(panel);
  expect(within(menu).queryByText(/Input round trip/)).toBeNull();

  await userEvent.click(within(menu).getByRole("menuitem", { name: "Browser settings" }));
  await userEvent.click(await settingsSwitch("Show connection stats"));

  await app.open(`/t/${threadId}`);
  const again = await screen.findByRole("region", { name: "Thread panel" });
  menu = await options(again);
  expect(within(menu).getByText("Input round trip 42 ms")).toBeTruthy();
});

test("an Extensions button hidden from the toolbar comes back from Settings › Browser", async () => {
  const app = harness();
  const { panel } = await openBrowser(app);
  await userEvent.click(within(panel).getByRole("button", { name: "Extensions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from toolbar" }));
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: "Extensions" })).toBeNull(),
  );

  const menu = await options(panel);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Browser settings" }));
  const shown = await settingsSwitch("Show Extensions button");
  expect(shown.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(shown);

  await app.open(`/t/${threadId}`);
  const again = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(again).findByRole("button", { name: "Extensions" })).toBeTruthy();
});

test("Use your Chrome's extensions opens Use my Chrome on Settings › Browser", async () => {
  const { panel } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Extensions" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Use your Chrome's extensions" }),
  );
  await screen.findByRole("heading", { name: "Browser", level: 2 });
  expect(await screen.findByText("Browser connection")).toBeTruthy();
});
