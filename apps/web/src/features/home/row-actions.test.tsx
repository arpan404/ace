import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = "Dedupe thread events after reconnect";

async function openHome() {
  const app = harness();
  const dedupe = workbench().find((scenario) => scenario.thread.title === title);
  if (!dedupe) throw new Error(`workbench lost ${title}`);
  app.play(dedupe).runUntilBlocked();
  await app.open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  await within(nav).findAllByRole("link");
  return app;
}

test("Snooze and Pin are available from the task context menu", async () => {
  await openHome();
  const row = within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
    name: /^Dedupe/,
  });
  if (!row) throw new Error("no task");
  await userEvent.pointer({ keys: "[MouseRight]", target: row });
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  expect(await screen.findByRole("menuitem", { name: /^Tomorrow/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(screen.getByRole("link", { name: /^Dedupe.*Pinned/ })).toBeTruthy());
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("link", { name: /^Dedupe/ }),
  });
  expect(await screen.findByRole("menuitem", { name: /^Unpin/ })).toBeTruthy();
});
