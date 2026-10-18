import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { harness } from "@/test/harness.tsx";

/** The cold-start thread, with its Browser open in the side panel on the agent's page. */
export async function openThreadBrowser(through?: string) {
  const scenario = coldStartReplay();
  const app = harness();
  const script = app.play(scenario);
  if (through) script.runThrough(through);
  else script.step();
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  // ⌃⇧B opens the Browser in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: "Live view of localhost:5173/settings/devices" });
  return { app, panel, browser: app.daemon.browser, script, thread: "thread-cold-start" };
}

/** Open the page's ⋯ menu and pick an item by name. */
export async function browserMenu(panel: HTMLElement, item: string | RegExp, index = 0) {
  const triggers = within(panel).getAllByRole("button", { name: "Browser options" });
  await userEvent.click(triggers[index] as HTMLElement);
  await userEvent.click(
    await screen
      .findByRole("menuitemcheckbox", { name: item })
      .catch(() => screen.findByRole("menuitem", { name: item })),
  );
}
