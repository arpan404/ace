import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * Beside the chat the editor holds four panes. Split right (⌥⌘\, Ctrl+Alt+\ off Apple) past that
 * makes nothing and says why in the status line, which a screen reader reads out.
 */

test("⌥⌘\\ at four panes beside the chat says so instead of splitting", async () => {
  const app = harness({ storage: memoryKeyValue() });
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "outbox.ts");
  await screen.findByRole("option", { name: /outbox\.ts/ });
  await userEvent.keyboard("{Enter}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const panes = () => within(panel).queryAllByRole("region", { name: /^Pane \d$/ });

  const lastView = async () =>
    (await within(panel).findAllByRole("textbox", { name: "outbox.ts" })).at(-1);
  for (let made = 1; made < 4; made += 1) {
    (await lastView())?.focus();
    await userEvent.keyboard("{Control>}{Alt>}\\{/Alt}{/Control}");
    await waitFor(() => expect(panes()).toHaveLength(made + 1));
  }
  (await lastView())?.focus();
  await userEvent.keyboard("{Control>}{Alt>}\\{/Alt}{/Control}");

  const status = await within(panel).findByText("Up to 4 panes beside the chat");
  expect(status.closest("[role=status]")).not.toBeNull();
  expect(panes()).toHaveLength(4);
});
