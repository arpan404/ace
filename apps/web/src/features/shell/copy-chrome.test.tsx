import { openWorkCard } from "@/test/open-work.ts";
import { replayCursor } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// The demo thread deliberately carries an older machine name. Every current-machine view
// must prefer the host identity instead of that saved metadata or the connection address.
test("the connected machine keeps its name in menus, settings and the Work card", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  app.daemon.services.settings.seed({ "host.displayName": "Workshop Mac" });
  const view = await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: /, account/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Connection" }));
  const menu = await screen.findByRole("menu", { name: "Connection" });
  expect(await within(menu).findByText("Workshop Mac")).toBeTruthy();
  expect(menu.textContent).toContain("Connected");
  expect(menu.textContent).not.toContain("memory://");
  expect(menu.textContent).not.toMatch(/daemon/i);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Connection settings" }));
  await screen.findByRole("heading", { name: "Advanced", level: 2 });
  await userEvent.click(await screen.findByRole("button", { name: "Show" }));
  expect(
    await within(screen.getByRole("region", { name: "Health" })).findByText("Workshop Mac"),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: "Remote devices", current: false }));
  expect(
    await within(await screen.findByRole("region", { name: "Machines" })).findByText(
      "Workshop Mac",
    ),
  ).toBeTruthy();
  view.unmount();
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openWorkCard();
  expect(within(card).getByRole("button", { name: /^Workshop Mac, / })).toBeTruthy();
});

test("unknown command failures explain recovery without showing the server's code", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  app.daemon.refuseCommands("internal_123_private_failure", "thread.rename");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Thread title" });
  await userEvent.clear(field);
  await userEvent.type(field, "A new title{Enter}");
  const toast = await screen.findByRole("region", { name: "Notifications" });
  await within(toast).findByText("ace couldn't complete that action. Try again.");
  expect(toast.textContent).toContain("ace couldn't complete that action. Try again.");
  expect(toast.textContent).not.toContain("internal_123_private_failure");
});

test("a thread on another machine keeps that machine's name", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "host.displayName": "Workshop Mac" });
  const scenario = replayCursor();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        details: {
          ...scenario.thread.details,
          machine: { host: "build-host", name: "Build server" },
        },
      },
    })
    .runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openWorkCard();
  expect(within(card).getByRole("button", { name: /^Build server, / })).toBeTruthy();
  expect(card.textContent).not.toContain("Workshop Mac");
});
