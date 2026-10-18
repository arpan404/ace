import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";
beforeEach(() => localStorage.clear());

test("Ask agent about this page puts the shown tab in the message as a mention that goes with it", async () => {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  const tab = app.daemon.browser.tab(threadId);
  if (!tab) throw new Error("Missing tab");
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context?.items);
    return receive(command);
  };
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(await within(panel).findByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Ask agent about this page" }));

  const message = screen.getByRole("combobox", { name: "Message" });
  await waitFor(() => expect(message.textContent).toContain("Fixture page"));
  await userEvent.type(message, "why is pairing slow?{Enter}");
  await waitFor(() =>
    expect(sent.at(-1)).toEqual([
      { type: "browser_tab", tabId: tab.tabId, url: tab.url, title: "Fixture page" },
    ]),
  );
});
