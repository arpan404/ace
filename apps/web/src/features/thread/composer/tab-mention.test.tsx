import { longHistory } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

const threadId = "thread-router";

async function open() {
  const app = harness({ storage: memoryKeyValue() });
  app.play(longHistory(2)).runUntilBlocked();
  // The thread's browser: the agent's pricing page, and a tab the person keeps agents out of.
  app.daemon.browser.drive(threadId, { url: "https://example.com/pricing" });
  const pricing = app.daemon.browser.tab(threadId);
  if (!pricing) throw new Error("Missing tab");
  pricing.title = "Pricing";
  const bank = app.daemon.browser.personOpen(threadId, "https://bank.example.com/");
  app.daemon.browser.setPrivate(threadId, bank, true);
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context?.items);
    return receive(command);
  };
  await app.open(`/t/${threadId}`);
  return {
    app,
    sent,
    pricing: pricing.tabId,
    message: await screen.findByRole("combobox", { name: "Message" }),
  };
}

test("@ lists the thread's open browser tabs, never a private one, and a picked tab goes with the message", async () => {
  const { sent, pricing, message } = await open();
  await userEvent.type(message, "Why is @");
  const menu = await screen.findByRole("listbox", { name: "Files and threads" });
  const option = await within(menu).findByRole("option", { name: /Pricing example\.com\/pricing/ });
  expect(within(menu).queryByRole("option", { name: /bank\.example\.com/ })).toBeNull();

  await userEvent.click(option);
  await userEvent.type(message, " so slow?{Enter}");
  await waitFor(() =>
    expect(sent.at(-1)).toEqual([
      {
        type: "browser_tab",
        tabId: pricing,
        url: "https://example.com/pricing",
        title: "Pricing",
      },
    ]),
  );
});
